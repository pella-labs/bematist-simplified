import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEnvelopeSchema } from "@bematist/contracts";
import { enumerateHistoricalFiles, readFileToEnvelopes } from "./backfillReader";

let root: string;

function userLine(uuid: string, sessionId: string, text: string, ts = "2026-04-16T14:00:00.000Z") {
  return `${JSON.stringify({
    type: "user",
    uuid,
    timestamp: ts,
    sessionId,
    cwd: "/tmp/demo",
    gitBranch: "main",
    version: "2.1.76",
    message: { role: "user", content: text },
  })}\n`;
}

function assistantLine(
  uuid: string,
  sessionId: string,
  text: string,
  ts = "2026-04-16T14:00:01.000Z",
) {
  return `${JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: ts,
    sessionId,
    cwd: "/tmp/demo",
    gitBranch: "main",
    version: "2.1.76",
    requestId: `req_${uuid}`,
    message: {
      id: `msg_${uuid}`,
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  })}\n`;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bm-pilot-claude-backfill-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("claude-code backfillReader.enumerateHistoricalFiles", () => {
  it("returns all .jsonl files under the projects root", async () => {
    const sub = join(root, "project-a");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "sess-1.jsonl"), userLine("u1", "s1", "hi"));
    await writeFile(join(sub, "sess-2.jsonl"), userLine("u2", "s2", "hi"));
    await writeFile(join(sub, "notes.txt"), "ignore me");

    const out = await enumerateHistoricalFiles({ root, sinceMs: 0 });
    const paths = out.map((f) => f.path).sort();
    expect(paths).toEqual([join(sub, "sess-1.jsonl"), join(sub, "sess-2.jsonl")]);
    for (const f of out) {
      expect(f.sizeBytes).toBeGreaterThan(0);
      expect(f.mtimeMs).toBeGreaterThan(0);
    }
  });

  it("skips files whose mtime is before sinceMs", async () => {
    const sub = join(root, "project-a");
    await mkdir(sub, { recursive: true });
    const oldPath = join(sub, "old.jsonl");
    const freshPath = join(sub, "fresh.jsonl");
    await writeFile(oldPath, userLine("u1", "s1", "old"));
    await writeFile(freshPath, userLine("u2", "s2", "fresh"));

    const oldTime = new Date("2020-01-01T00:00:00Z");
    await utimes(oldPath, oldTime, oldTime);

    const out = await enumerateHistoricalFiles({ root, sinceMs: Date.now() - 60_000 });
    const paths = out.map((f) => f.path);
    expect(paths).toContain(freshPath);
    expect(paths).not.toContain(oldPath);
  });

  it("returns empty array when root does not exist", async () => {
    const out = await enumerateHistoricalFiles({ root: join(root, "nope"), sinceMs: 0 });
    expect(out).toEqual([]);
  });
});

describe("claude-code backfillReader.readFileToEnvelopes", () => {
  it("emits session_start first, then line-derived envelopes, then session_end", async () => {
    const sub = join(root, "p");
    await mkdir(sub, { recursive: true });
    const path = join(sub, "sess.jsonl");
    const content =
      userLine("u1", "sess-X", "hello", "2026-04-16T14:00:00.000Z") +
      assistantLine("u2", "sess-X", "hi back", "2026-04-16T14:00:01.000Z");
    await writeFile(path, content);

    const envelopes = [];
    for await (const env of readFileToEnvelopes(path, {
      deviceId: "dev-x",
      clientVersion: "0.1.0-test",
    })) {
      envelopes.push(env);
    }

    expect(envelopes.length).toBeGreaterThanOrEqual(3);
    expect(envelopes[0]?.kind).toBe("session_start");
    expect(envelopes[envelopes.length - 1]?.kind).toBe("session_end");
    const middle = envelopes.slice(1, -1);
    expect(middle.map((e) => e.kind)).toEqual(["user_prompt", "assistant_response"]);

    for (const env of envelopes) {
      expect(() => EventEnvelopeSchema.parse(env)).not.toThrow();
      expect(env.source).toBe("claude-code");
      expect(env.source_session_id).toBe("sess-X");
    }

    const seqs = envelopes.map((e) => e.event_seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? -1);
    }
  });

  it("assigns a single client session_id per file", async () => {
    const sub = join(root, "p");
    await mkdir(sub, { recursive: true });
    const path = join(sub, "sess.jsonl");
    await writeFile(
      path,
      userLine("u1", "sess-Y", "a") + userLine("u2", "sess-Y", "b", "2026-04-16T14:00:01.000Z"),
    );
    const envelopes = [];
    for await (const env of readFileToEnvelopes(path, {
      deviceId: "dev-x",
      clientVersion: "0.1.0-test",
    })) {
      envelopes.push(env);
    }
    const ids = new Set(envelopes.map((e) => e.session_id));
    expect(ids.size).toBe(1);
  });

  it("yields nothing for an empty file (no session_start without any records)", async () => {
    const sub = join(root, "p");
    await mkdir(sub, { recursive: true });
    const path = join(sub, "empty.jsonl");
    await writeFile(path, "");

    const envelopes = [];
    for await (const env of readFileToEnvelopes(path, {
      deviceId: "dev-x",
      clientVersion: "0.1.0-test",
    })) {
      envelopes.push(env);
    }
    expect(envelopes).toEqual([]);
  });
});

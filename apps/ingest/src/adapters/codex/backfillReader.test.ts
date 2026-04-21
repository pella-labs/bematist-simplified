import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEnvelopeSchema } from "@bematist/contracts";
import { enumerateHistoricalFiles, readFileToEnvelopes } from "./backfillReader";

let root: string;

const SAMPLE_LINES = [
  `${JSON.stringify({
    timestamp: "2026-04-16T14:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "sess-X",
      timestamp: "2026-04-16T14:00:00.000Z",
      cwd: "/tmp/repo",
      cli_version: "0.120.0",
      model_provider: "openai",
    },
  })}`,
  `${JSON.stringify({
    session_id: "sess-X",
    turn_id: "t1",
    timestamp: "2026-04-16T14:00:01.000Z",
    event_msg: {
      type: "user_message",
      payload: { role: "user", content: "refactor foo.ts" },
    },
  })}`,
  `${JSON.stringify({
    session_id: "sess-X",
    turn_id: "t1",
    timestamp: "2026-04-16T14:00:02.000Z",
    event_msg: {
      type: "agent_message",
      payload: { role: "assistant", model: "gpt-5.3-codex", content: "ok" },
    },
  })}`,
  `${JSON.stringify({
    session_id: "sess-X",
    turn_id: "t1",
    timestamp: "2026-04-16T14:00:03.000Z",
    event_msg: {
      type: "token_count",
      payload: {
        model: "gpt-5.3-codex",
        input_tokens: 100,
        output_tokens: 10,
        cached_input_tokens: 0,
        total_tokens: 110,
      },
    },
  })}`,
  `${JSON.stringify({
    type: "session_end",
    session_id: "sess-X",
    timestamp: "2026-04-16T14:00:04.000Z",
  })}`,
].join("\n");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bm-pilot-codex-backfill-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("codex backfillReader.enumerateHistoricalFiles", () => {
  it("returns rollout-*.jsonl files under the sessions root", async () => {
    const sub = join(root, "2026", "04");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "rollout-abc.jsonl"), SAMPLE_LINES);
    await writeFile(join(sub, "rollout-xyz.jsonl"), SAMPLE_LINES);
    await writeFile(join(sub, "other.jsonl"), "ignore");
    await writeFile(join(sub, "rollout-ignored.txt"), "nope");

    const out = await enumerateHistoricalFiles({ root, sinceMs: 0 });
    const names = out.map((f) => f.path.split("/").pop()).sort();
    expect(names).toEqual(["rollout-abc.jsonl", "rollout-xyz.jsonl"]);
  });

  it("skips rollouts older than sinceMs", async () => {
    const sub = join(root, "2026", "04");
    await mkdir(sub, { recursive: true });
    const old = join(sub, "rollout-old.jsonl");
    const fresh = join(sub, "rollout-fresh.jsonl");
    await writeFile(old, SAMPLE_LINES);
    await writeFile(fresh, SAMPLE_LINES);
    const t = new Date("2020-01-01T00:00:00Z");
    await utimes(old, t, t);

    const out = await enumerateHistoricalFiles({ root, sinceMs: Date.now() - 60_000 });
    const paths = out.map((f) => f.path);
    expect(paths).toContain(fresh);
    expect(paths).not.toContain(old);
  });

  it("returns empty when root does not exist", async () => {
    const out = await enumerateHistoricalFiles({ root: join(root, "nope"), sinceMs: 0 });
    expect(out).toEqual([]);
  });
});

describe("codex backfillReader.readFileToEnvelopes", () => {
  it("emits session_start first and explicit session_end last", async () => {
    const sub = join(root, "s");
    await mkdir(sub, { recursive: true });
    const path = join(sub, "rollout-sessX.jsonl");
    await writeFile(path, SAMPLE_LINES);

    const envelopes = [];
    for await (const env of readFileToEnvelopes(path, {
      deviceId: "dev-x",
      clientVersion: "0.1.0-test",
    })) {
      envelopes.push(env);
    }

    expect(envelopes[0]?.kind).toBe("session_start");
    expect(envelopes[envelopes.length - 1]?.kind).toBe("session_end");

    for (const env of envelopes) {
      expect(() => EventEnvelopeSchema.parse(env)).not.toThrow();
      expect(env.source).toBe("codex");
      expect(env.source_session_id).toBe("sess-X");
    }

    const kinds = envelopes.map((e) => e.kind);
    expect(kinds).toContain("user_prompt");
    expect(kinds).toContain("assistant_response");

    const seqs = envelopes.map((e) => e.event_seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? -1);
    }
  });

  it("uses a single client session_id per file and resets tokenDiff across files", async () => {
    const sub = join(root, "s");
    await mkdir(sub, { recursive: true });
    const pathA = join(sub, "rollout-A.jsonl");
    const pathB = join(sub, "rollout-B.jsonl");
    const twoTurns = [
      `${JSON.stringify({
        timestamp: "2026-04-16T14:00:00.000Z",
        type: "session_meta",
        payload: { id: "sA", cwd: "/tmp/a" },
      })}`,
      `${JSON.stringify({
        session_id: "sA",
        turn_id: "t1",
        timestamp: "2026-04-16T14:00:01.000Z",
        event_msg: {
          type: "user_message",
          payload: { role: "user", content: "q1" },
        },
      })}`,
      `${JSON.stringify({
        session_id: "sA",
        turn_id: "t1",
        timestamp: "2026-04-16T14:00:02.000Z",
        event_msg: {
          type: "agent_message",
          payload: { role: "assistant", model: "gpt-5.3-codex", content: "a1" },
        },
      })}`,
      `${JSON.stringify({
        session_id: "sA",
        turn_id: "t1",
        timestamp: "2026-04-16T14:00:03.000Z",
        event_msg: {
          type: "token_count",
          payload: {
            model: "gpt-5.3-codex",
            input_tokens: 500,
            output_tokens: 200,
            cached_input_tokens: 0,
            total_tokens: 700,
          },
        },
      })}`,
    ].join("\n");

    await writeFile(pathA, twoTurns);
    await writeFile(
      pathB,
      [
        `${JSON.stringify({
          timestamp: "2026-04-16T14:00:00.000Z",
          type: "session_meta",
          payload: { id: "sB", cwd: "/tmp/b" },
        })}`,
        `${JSON.stringify({
          session_id: "sB",
          turn_id: "t1",
          timestamp: "2026-04-16T14:00:01.000Z",
          event_msg: {
            type: "user_message",
            payload: { role: "user", content: "q2" },
          },
        })}`,
        `${JSON.stringify({
          session_id: "sB",
          turn_id: "t1",
          timestamp: "2026-04-16T14:00:02.000Z",
          event_msg: {
            type: "agent_message",
            payload: { role: "assistant", model: "gpt-5.3-codex", content: "a2" },
          },
        })}`,
        `${JSON.stringify({
          session_id: "sB",
          turn_id: "t1",
          timestamp: "2026-04-16T14:00:03.000Z",
          event_msg: {
            type: "token_count",
            payload: {
              model: "gpt-5.3-codex",
              input_tokens: 100,
              output_tokens: 50,
              cached_input_tokens: 0,
              total_tokens: 150,
            },
          },
        })}`,
      ].join("\n"),
    );

    const envA = [];
    for await (const e of readFileToEnvelopes(pathA, {
      deviceId: "dev-x",
      clientVersion: "0.1.0-test",
    })) {
      envA.push(e);
    }
    const envB = [];
    for await (const e of readFileToEnvelopes(pathB, {
      deviceId: "dev-x",
      clientVersion: "0.1.0-test",
    })) {
      envB.push(e);
    }

    const aClientIds = new Set(envA.map((e) => e.session_id));
    const bClientIds = new Set(envB.map((e) => e.session_id));
    expect(aClientIds.size).toBe(1);
    expect(bClientIds.size).toBe(1);
    expect([...aClientIds][0]).not.toBe([...bClientIds][0]);

    const bUsageEvents = envB.filter((e) => e.usage && e.usage.input_tokens > 0);
    expect(bUsageEvents.length).toBeGreaterThan(0);
    const b = bUsageEvents[0];
    if (!b) throw new Error("no usage event");
    expect(b.usage?.input_tokens).toBe(100);
    expect(b.usage?.output_tokens).toBe(50);
  });

  it("yields nothing for an empty rollout", async () => {
    const sub = join(root, "s");
    await mkdir(sub, { recursive: true });
    const path = join(sub, "rollout-empty.jsonl");
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

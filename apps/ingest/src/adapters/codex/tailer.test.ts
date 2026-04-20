import { afterEach, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@bematist/contracts";
import { EventEnvelopeSchema } from "@bematist/contracts";
import { CodexTailer } from "./tailer";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "test", "fixtures", "codex");

const tmpRoots: string[] = [];

afterEach(() => {
  while (tmpRoots.length > 0) {
    const p = tmpRoots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

interface Harness {
  root: string;
  sessionsDir: string;
  offsetsPath: string;
  offsetsLockPath: string;
  events: EventEnvelope[];
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "codex-tailer-"));
  tmpRoots.push(root);
  const sessionsDir = join(root, "sessions", "2026", "04", "16");
  mkdirSync(sessionsDir, { recursive: true });
  const offsetsPath = join(root, "bematist", "offsets.json");
  const offsetsLockPath = join(root, "bematist", "offsets.lock");
  mkdirSync(join(root, "bematist"), { recursive: true });
  return { root, sessionsDir, offsetsPath, offsetsLockPath, events: [] };
}

function makeTailer(h: Harness, overrides: Record<string, unknown> = {}): CodexTailer {
  const emit = (e: EventEnvelope) => {
    const parsed = EventEnvelopeSchema.safeParse(e);
    if (!parsed.success) {
      throw new Error(`invalid envelope: ${JSON.stringify(parsed.error.issues)}`);
    }
    h.events.push(e);
  };
  return new CodexTailer({
    emit,
    clientVersion: "test-0.1.0",
    sessionsDir: join(h.root, "sessions"),
    offsetsPath: h.offsetsPath,
    offsetsLockPath: h.offsetsLockPath,
    pollIntervalMs: 50,
    watch: false,
    platform: "linux",
    log: () => {},
    ...overrides,
  });
}

describe("CodexTailer — poll fixtures", () => {
  it("copies rollout-basic and emits expected kinds with monotonic event_seq", async () => {
    const h = makeHarness();
    const dest = join(h.sessionsDir, "rollout-basic.jsonl");
    copyFileSync(join(FIXTURES, "rollout-basic.jsonl"), dest);
    // Pre-seed offset so we skip pre-existing content and re-emit via "fresh file first visit"
    // by deleting the offset — but we want a full read, so leave offsets empty.
    writeFileSync(h.offsetsPath, JSON.stringify({ codex: { [dest]: 0 } }));
    const tailer = makeTailer(h);
    await tailer.start();
    await tailer.stop();
    expect(h.events.length).toBeGreaterThan(0);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain("session_start");
    expect(kinds).toContain("user_prompt");
    expect(kinds).toContain("assistant_response");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("session_end");
    // event_seq per session is monotonic starting at 0
    const bySession = new Map<string, number[]>();
    for (const e of h.events) {
      const arr = bySession.get(e.session_id) ?? [];
      arr.push(e.event_seq);
      bySession.set(e.session_id, arr);
    }
    for (const seqs of bySession.values()) {
      for (let i = 1; i < seqs.length; i++) {
        expect((seqs[i] as number) > (seqs[i - 1] as number)).toBe(true);
      }
      expect(seqs[0]).toBe(0);
    }
  });

  it("derives per-turn token deltas from cumulative token_count records", async () => {
    const h = makeHarness();
    const dest = join(h.sessionsDir, "rollout-basic.jsonl");
    copyFileSync(join(FIXTURES, "rollout-basic.jsonl"), dest);
    writeFileSync(h.offsetsPath, JSON.stringify({ codex: { [dest]: 0 } }));
    const tailer = makeTailer(h);
    await tailer.start();
    await tailer.stop();
    const assistantWithUsage = h.events.filter(
      (e) => e.kind === "assistant_response" && e.usage !== null,
    );
    expect(assistantWithUsage.length).toBe(2);
    // First token_count: input=1200, output=300, cached=400 (cumulative = delta since zero)
    expect(assistantWithUsage[0]?.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_tokens: 400,
      cache_creation_tokens: 0,
    });
    // Second token_count: 2100-1200=900, 500-300=200, 800-400=400
    expect(assistantWithUsage[1]?.usage).toEqual({
      input_tokens: 900,
      output_tokens: 200,
      cache_read_tokens: 400,
      cache_creation_tokens: 0,
    });
  });

  it("resets cumulative token state when a new session_meta appears in a new file", async () => {
    const h = makeHarness();
    const a = join(h.sessionsDir, "rollout-a.jsonl");
    const b = join(h.sessionsDir, "rollout-b.jsonl");
    copyFileSync(join(FIXTURES, "rollout-basic.jsonl"), a);
    copyFileSync(join(FIXTURES, "rollout-basic.jsonl"), b);
    writeFileSync(h.offsetsPath, JSON.stringify({ codex: { [a]: 0, [b]: 0 } }));
    const tailer = makeTailer(h);
    await tailer.start();
    await tailer.stop();
    const byFileFirstDelta = new Map<string, number>();
    for (const e of h.events) {
      if (e.kind !== "assistant_response" || e.usage === null) continue;
      if (byFileFirstDelta.has(e.session_id)) continue;
      byFileFirstDelta.set(e.session_id, e.usage.input_tokens);
    }
    expect(byFileFirstDelta.size).toBe(2);
    for (const v of byFileFirstDelta.values()) expect(v).toBe(1200);
  });

  it("picks up lines appended after initial discovery and persists offset", async () => {
    const h = makeHarness();
    const dest = join(h.sessionsDir, "rollout-append.jsonl");
    writeFileSync(dest, "");
    // First pass: empty file, tailer records offset=0 for this path.
    const tailer1 = makeTailer(h);
    await tailer1.start();
    await tailer1.stop();
    // Append a session_meta + assistant record with usage.
    const lines = [
      JSON.stringify({
        timestamp: "2026-04-16T14:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "appended",
          cwd: "/tmp/x",
          cli_version: "0.1",
          originator: "Codex",
        },
      }),
      JSON.stringify({
        session_id: "appended",
        turn_id: "t1",
        timestamp: "2026-04-16T14:00:01.000Z",
        event_msg: {
          type: "agent_message",
          payload: { role: "assistant", model: "gpt-5", content: "hi" },
        },
      }),
      "",
    ];
    appendFileSync(dest, lines.join("\n"));
    const tailer2 = makeTailer(h);
    await tailer2.start();
    await tailer2.stop();
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain("session_start");
    expect(kinds).toContain("assistant_response");
    // offsets.json now has a non-zero entry under codex namespace.
    const off = JSON.parse(readFileSync(h.offsetsPath, "utf8"));
    const val = off.codex?.[dest];
    expect(typeof val).toBe("number");
    expect(val).toBeGreaterThan(0);
  });

  it("offsets.json merge preserves sibling 'claude-code' namespace", async () => {
    const h = makeHarness();
    const dest = join(h.sessionsDir, "rollout-siblings.jsonl");
    copyFileSync(join(FIXTURES, "rollout-basic.jsonl"), dest);
    writeFileSync(
      h.offsetsPath,
      JSON.stringify({
        "claude-code": { "/home/u/.claude/projects/x.jsonl": 12345 },
        codex: { [dest]: 0 },
      }),
    );
    const tailer = makeTailer(h);
    await tailer.start();
    await tailer.stop();
    const after = JSON.parse(readFileSync(h.offsetsPath, "utf8"));
    expect(after["claude-code"]).toEqual({ "/home/u/.claude/projects/x.jsonl": 12345 });
    expect(typeof after.codex[dest]).toBe("number");
    expect(after.codex[dest]).toBeGreaterThan(0);
  });

  it("on Windows, shells out to git rev-parse HEAD for session_meta and attaches sha", async () => {
    const h = makeHarness();
    const dest = join(h.sessionsDir, "rollout-win.jsonl");
    copyFileSync(join(FIXTURES, "rollout-basic.jsonl"), dest);
    writeFileSync(h.offsetsPath, JSON.stringify({ codex: { [dest]: 0 } }));
    const gitCalls: string[] = [];
    const runGit = async (cwd: string) => {
      gitCalls.push(cwd);
      return "a".repeat(40);
    };
    const tailer = makeTailer(h, { platform: "win32", runGit });
    await tailer.start();
    await tailer.stop();
    expect(gitCalls).toEqual(["/tmp/repo-basic"]);
    const withSha = h.events.find((e) => e.git_sha !== null);
    expect(withSha?.git_sha).toBe("a".repeat(40));
  });

  it("respects a pre-seeded offset and only emits newly appended lines", async () => {
    const h = makeHarness();
    const dest = join(h.sessionsDir, "rollout-offset.jsonl");
    copyFileSync(join(FIXTURES, "rollout-basic.jsonl"), dest);
    const size = readFileSync(dest, "utf8").length;
    writeFileSync(h.offsetsPath, JSON.stringify({ codex: { [dest]: size } }));
    const appended = `${JSON.stringify({
      session_id: "tail-appended",
      turn_id: "t-late",
      timestamp: "2026-04-16T14:00:10.000Z",
      event_msg: {
        type: "user_message",
        payload: { role: "user", content: "later prompt" },
      },
    })}\n`;
    appendFileSync(dest, appended);
    const tailer = makeTailer(h);
    await tailer.start();
    await tailer.stop();
    const prompts = h.events.filter((e) => e.kind === "user_prompt");
    expect(prompts.length).toBe(1);
    if (prompts[0]?.payload.kind !== "user_prompt") throw new Error("kind");
    expect(prompts[0].payload.text).toBe("later prompt");
  });

  it("emits envelopes that validate against EventEnvelopeSchema", async () => {
    const h = makeHarness();
    const dest = join(h.sessionsDir, "rollout-valid.jsonl");
    copyFileSync(join(FIXTURES, "rollout-basic.jsonl"), dest);
    writeFileSync(h.offsetsPath, JSON.stringify({ codex: { [dest]: 0 } }));
    const tailer = makeTailer(h);
    await tailer.start();
    await tailer.stop();
    expect(h.events.length).toBeGreaterThan(0);
    // emit() throws on invalid envelope, so reaching here means all are valid.
    for (const e of h.events) {
      expect(e.source).toBe("codex");
      expect(e.schema_version).toBe(1);
    }
  });

  it("on first visit to a brand-new rollout file with no saved offset, tails from end (no backfill)", async () => {
    const h = makeHarness();
    const dest = join(h.sessionsDir, "rollout-fresh.jsonl");
    copyFileSync(join(FIXTURES, "rollout-basic.jsonl"), dest);
    // No entry for this file in offsets → tail-from-end behavior.
    writeFileSync(h.offsetsPath, JSON.stringify({ codex: {} }));
    const tailer = makeTailer(h);
    await tailer.start();
    await tailer.stop();
    expect(h.events.length).toBe(0);
    // A later append is picked up.
    const appended = `${JSON.stringify({
      session_id: "fresh",
      timestamp: "2026-04-16T14:00:20.000Z",
      type: "session_meta",
      payload: { id: "fresh", cwd: "/tmp/z", cli_version: "0.1", originator: "Codex" },
    })}\n`;
    appendFileSync(dest, appended);
    const tailer2 = makeTailer(h);
    await tailer2.start();
    await tailer2.stop();
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain("session_start");
  });
});

import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EventEnvelopeSchema } from "@bematist/contracts";
import {
  makeSessionEndEnvelope,
  makeSessionStartEnvelope,
  type ParseContext,
  parseLineToEnvelopes,
} from "./parseSessionFile";

const FIXTURE_DIR = join(import.meta.dir, "..", "..", "..", "test", "fixtures", "claude-code");

function makeCtx(overrides: Partial<ParseContext> = {}): ParseContext {
  let seq = 0;
  const seen = new Set<string>();
  return {
    clientSessionId: "client-sess-uuid",
    clientVersion: "0.1.0-test",
    nextSeq: () => seq++,
    isDuplicate: (uuid) => {
      if (seen.has(uuid)) return true;
      seen.add(uuid);
      return false;
    },
    gitSha: () => null,
    ...overrides,
  };
}

describe("parseLineToEnvelopes", () => {
  it("parses the basic fixture into the expected mix of kinds", async () => {
    const text = await readFile(join(FIXTURE_DIR, "session-basic.jsonl"), "utf8");
    const ctx = makeCtx();
    const events = text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .flatMap((l) => parseLineToEnvelopes(l, ctx));

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "user_prompt",
      "assistant_response",
      "assistant_response",
      "tool_call",
      "tool_result",
      "assistant_response",
    ]);
    for (const e of events) expect(() => EventEnvelopeSchema.parse(e)).not.toThrow();
  });

  it("emits monotonically increasing event_seq", async () => {
    const text = await readFile(join(FIXTURE_DIR, "session-basic.jsonl"), "utf8");
    const ctx = makeCtx();
    const events = text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .flatMap((l) => parseLineToEnvelopes(l, ctx));
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const cur = events[i];
      if (!prev || !cur) continue;
      expect(cur.event_seq).toBeGreaterThan(prev.event_seq);
    }
  });

  it("populates usage on assistant_response from message.usage", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "u1",
      timestamp: "2026-04-16T14:00:01.000Z",
      sessionId: "s1",
      cwd: "/x",
      gitBranch: "main",
      message: {
        id: "msg_1",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 7,
        },
      },
    });
    const ctx = makeCtx();
    const [ev] = parseLineToEnvelopes(line, ctx);
    expect(ev).toBeDefined();
    expect(ev?.kind).toBe("assistant_response");
    expect(ev?.model).toBe("claude-sonnet-4-5");
    expect(ev?.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 100,
      cache_creation_tokens: 7,
    });
  });

  it("emits tool_call for nested tool_use blocks with assistant text", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "u2",
      timestamp: "2026-04-16T14:00:01.000Z",
      sessionId: "s1",
      cwd: "/x",
      gitBranch: "main",
      message: {
        id: "msg_2",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [
          { type: "text", text: "Running a tool" },
          { type: "tool_use", id: "toolu_xy", name: "Bash", input: { command: "ls" } },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
    const events = parseLineToEnvelopes(line, makeCtx());
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("assistant_response");
    expect(events[1]?.kind).toBe("tool_call");
    if (events[1]?.payload.kind === "tool_call") {
      expect(events[1].payload.tool_name).toBe("Bash");
      expect(events[1].payload.tool_use_id).toBe("toolu_xy");
      expect(events[1].payload.tool_input).toEqual({ command: "ls" });
    }
  });

  it("emits tool_result for user messages carrying tool_result blocks", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "u3",
      timestamp: "2026-04-16T14:00:02.200Z",
      sessionId: "s1",
      cwd: "/x",
      gitBranch: "main",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_xy",
            content: "file contents",
            is_error: false,
          },
        ],
      },
    });
    const [ev] = parseLineToEnvelopes(line, makeCtx());
    expect(ev).toBeDefined();
    expect(ev?.kind).toBe("tool_result");
    if (ev?.payload.kind === "tool_result") {
      expect(ev.payload.tool_use_id).toBe("toolu_xy");
      expect(ev.payload.is_error).toBe(false);
      expect(ev.payload.tool_output).toBe("file contents");
    }
    expect(ev?.success).toBe(true);
  });

  it("deduplicates records with identical uuid", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "dup-uuid",
      timestamp: "2026-04-16T14:00:00.000Z",
      sessionId: "s-dup",
      message: { role: "user", content: "first" },
    });
    const ctx = makeCtx();
    const first = parseLineToEnvelopes(line, ctx);
    const second = parseLineToEnvelopes(line, ctx);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("skips non-JSON and non-message lines", () => {
    expect(parseLineToEnvelopes("", makeCtx())).toEqual([]);
    expect(parseLineToEnvelopes("not json", makeCtx())).toEqual([]);
    const snapshot = JSON.stringify({
      type: "file-history-snapshot",
      messageId: "m",
    });
    expect(parseLineToEnvelopes(snapshot, makeCtx())).toEqual([]);
  });

  it("skips records without uuid", () => {
    const line = JSON.stringify({
      type: "user",
      timestamp: "2026-04-16T14:00:00.000Z",
      message: { role: "user", content: "hi" },
    });
    expect(parseLineToEnvelopes(line, makeCtx())).toEqual([]);
  });

  it("populates git_sha from the context callback", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "u-git",
      timestamp: "2026-04-16T14:00:00.000Z",
      sessionId: "s-git",
      cwd: "/x",
      gitBranch: "main",
      message: { role: "user", content: "hello" },
    });
    const ctx = makeCtx({ gitSha: () => "deadbeefcafe" });
    const [ev] = parseLineToEnvelopes(line, ctx);
    expect(ev?.git_sha).toBe("deadbeefcafe");
  });

  it("emits valid session_start and session_end envelopes", () => {
    const start = makeSessionStartEnvelope({
      clientSessionId: "cs",
      sourceSessionId: "ss",
      clientVersion: "0.1.0",
      cwd: "/x",
      gitBranch: "main",
      gitSha: "abc",
      sourceVersion: "2.1.0",
      ts: new Date().toISOString(),
      seq: 0,
    });
    const end = makeSessionEndEnvelope({
      clientSessionId: "cs",
      sourceSessionId: "ss",
      clientVersion: "0.1.0",
      cwd: "/x",
      gitBranch: "main",
      gitSha: "abc",
      sourceVersion: "2.1.0",
      ts: new Date().toISOString(),
      seq: 1,
      reason: "rotated",
    });
    expect(() => EventEnvelopeSchema.parse(start)).not.toThrow();
    expect(() => EventEnvelopeSchema.parse(end)).not.toThrow();
    expect(start.kind).toBe("session_start");
    expect(end.kind).toBe("session_end");
  });
});

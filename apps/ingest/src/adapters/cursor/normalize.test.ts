import { describe, expect, test } from "bun:test";
import { EventEnvelopeSchema } from "@bematist/contracts";
import { CURSOR_HOOK_EVENTS, normalize, parseHookInput } from "./normalize";

function seqFactory(): (k: string) => number {
  const m = new Map<string, number>();
  return (key: string) => {
    const n = m.get(key) ?? 0;
    m.set(key, n + 1);
    return n;
  };
}

const ctx = () => ({ clientVersion: "0.1.0", seqFor: seqFactory() });

describe("normalize", () => {
  test("all 8 hook shapes map to valid EventEnvelopes with correct kinds", () => {
    const kinds: Record<(typeof CURSOR_HOOK_EVENTS)[number], string> = {
      beforeSubmitPrompt: "user_prompt",
      afterAgentResponse: "assistant_response",
      preToolUse: "tool_call",
      postToolUse: "tool_result",
      afterShellExecution: "tool_result",
      afterFileEdit: "tool_result",
      sessionStart: "session_start",
      sessionEnd: "session_end",
    };
    for (const event of CURSOR_HOOK_EVENTS) {
      const input = {
        hook_event_name: event,
        session_id: "sess-123",
        prompt: "hi",
        response: "ok",
        tool_name: "edit",
        tool_input: { path: "/x" },
        tool_output: { ok: true },
        output: "shell output",
      };
      const { event: envelope } = normalize(input, ctx());
      expect(envelope.kind).toBe(kinds[event] as typeof envelope.kind);
      const parsed = EventEnvelopeSchema.safeParse(envelope);
      expect(parsed.success).toBe(true);
    }
  });

  test("beforeSubmitPrompt pulls text from `prompt` field", () => {
    const { event } = normalize(
      { hook_event_name: "beforeSubmitPrompt", session_id: "s1", prompt: "refactor foo" },
      ctx(),
    );
    expect(event.kind).toBe("user_prompt");
    if (event.payload.kind === "user_prompt") {
      expect(event.payload.text).toBe("refactor foo");
    }
  });

  test("afterAgentResponse handles missing stop_reason", () => {
    const { event } = normalize(
      { hook_event_name: "afterAgentResponse", session_id: "s1", response: "done" },
      ctx(),
    );
    if (event.payload.kind === "assistant_response") {
      expect(event.payload.text).toBe("done");
      expect(event.payload.stop_reason).toBeNull();
    }
  });

  test("preToolUse captures tool_input verbatim", () => {
    const input = { command: "ls -la", cwd: "/tmp" };
    const { event } = normalize(
      {
        hook_event_name: "preToolUse",
        session_id: "s1",
        tool_name: "bash",
        tool_input: input,
        tool_use_id: "tu_abc",
      },
      ctx(),
    );
    if (event.payload.kind === "tool_call") {
      expect(event.payload.tool_name).toBe("bash");
      expect(event.payload.tool_input).toEqual(input);
      expect(event.payload.tool_use_id).toBe("tu_abc");
    }
  });

  test("missing optional fields tolerated — validation at boundary still passes", () => {
    const { event } = normalize({ hook_event_name: "sessionStart", session_id: "abc" }, ctx());
    const parsed = EventEnvelopeSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    expect(event.cwd).toBeNull();
    expect(event.git_branch).toBeNull();
    expect(event.model).toBeNull();
    expect(event.usage).toBeNull();
  });

  test("extra unknown fields pass through into raw", () => {
    const input = {
      hook_event_name: "beforeSubmitPrompt",
      session_id: "s1",
      prompt: "p",
      whatever_new_field: 42,
      extra: { nested: true },
    };
    const { event } = normalize(input, ctx());
    expect(event.raw).toEqual(input);
  });

  test("unknown hook_event_name is rejected", () => {
    expect(() => normalize({ hook_event_name: "somethingElse", session_id: "s1" }, ctx())).toThrow(
      /unknown cursor hook event/,
    );
  });

  test("parseHookInput rejects non-object JSON", () => {
    expect(() => parseHookInput("42")).toThrow();
    expect(() => parseHookInput("null")).toThrow();
  });

  test("same source_session_id → same derived session_id across events", () => {
    const make = ctx();
    const a = normalize({ hook_event_name: "sessionStart", session_id: "cursor-1" }, make).event
      .session_id;
    const b = normalize(
      { hook_event_name: "beforeSubmitPrompt", session_id: "cursor-1", prompt: "x" },
      make,
    ).event.session_id;
    expect(a).toBe(b);
  });

  test("usage with camelCase fields is normalized", () => {
    const { event } = normalize(
      {
        hook_event_name: "afterAgentResponse",
        session_id: "s1",
        response: "ok",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      },
      ctx(),
    );
    expect(event.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
  });

  test("afterShellExecution becomes tool_result with tool_name=shell", () => {
    const { event } = normalize(
      {
        hook_event_name: "afterShellExecution",
        session_id: "s1",
        output: "hello world",
        is_error: false,
      },
      ctx(),
    );
    if (event.payload.kind === "tool_result") {
      expect(event.payload.tool_name).toBe("shell");
      expect(event.payload.tool_output).toBe("hello world");
      expect(event.payload.is_error).toBe(false);
    }
  });

  test("afterFileEdit becomes tool_result with tool_name=edit", () => {
    const { event } = normalize(
      {
        hook_event_name: "afterFileEdit",
        session_id: "s1",
        diff: "- old\n+ new\n",
      },
      ctx(),
    );
    if (event.payload.kind === "tool_result") {
      expect(event.payload.tool_name).toBe("edit");
      expect(event.payload.tool_output).toBe("- old\n+ new\n");
    }
  });

  test("event_seq increments per session across calls", () => {
    const make = ctx();
    const e1 = normalize({ hook_event_name: "sessionStart", session_id: "x" }, make).event;
    const e2 = normalize(
      { hook_event_name: "beforeSubmitPrompt", session_id: "x", prompt: "p" },
      make,
    ).event;
    const e3 = normalize({ hook_event_name: "sessionEnd", session_id: "x" }, make).event;
    expect(e1.event_seq).toBe(0);
    expect(e2.event_seq).toBe(1);
    expect(e3.event_seq).toBe(2);
  });
});

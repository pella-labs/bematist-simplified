import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@bematist/contracts";

export function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  const base: EventEnvelope = {
    client_event_id: randomUUID(),
    schema_version: 1,
    session_id: "sess-fixture-1",
    source_session_id: "src-sess-fixture-1",
    source: "claude-code",
    source_version: "1.2.3",
    client_version: "0.1.0",
    ts: new Date("2026-04-19T12:00:00.000Z").toISOString(),
    event_seq: 0,
    kind: "user_prompt",
    payload: { kind: "user_prompt", text: "hello" },
    cwd: "/home/dev/repo",
    git_branch: "main",
    git_sha: null,
    model: null,
    usage: null,
    duration_ms: null,
    success: null,
    raw: null,
  };
  return { ...base, ...overrides };
}

export function makeAssistantEnvelope(
  model: string,
  usage: { input: number; output: number; cacheRead?: number; cacheCreate?: number },
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return makeEnvelope({
    kind: "assistant_response",
    payload: { kind: "assistant_response", text: "reply", stop_reason: "end_turn" },
    model,
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_tokens: usage.cacheRead ?? 0,
      cache_creation_tokens: usage.cacheCreate ?? 0,
    },
    ...overrides,
  });
}

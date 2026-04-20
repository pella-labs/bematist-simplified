import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@bematist/contracts";
import type { Adapter, AdapterContext, EmitFn, Stop } from "./types";

const SOURCE = "claude-code" as const;
const SOURCE_VERSION = "mock-0.0.0";
const EVENTS_PER_SECOND = 5;

interface MockSession {
  sessionId: string;
  sourceSessionId: string;
  seq: number;
  cwd: string;
  branch: string;
  sha: string;
}

export function createMockAdapter(ctx: AdapterContext, sessionCount = 2): Adapter {
  return {
    name: "mock",
    async start(emit: EmitFn): Promise<Stop> {
      const sessions = makeSessions(Math.max(1, Math.min(3, sessionCount)));
      for (const s of sessions) emit(makeSessionStart(s, ctx.clientVersion));
      const interval = setInterval(
        () => {
          const s = sessions[Math.floor(Math.random() * sessions.length)];
          if (!s) return;
          emit(makeStep(s, ctx.clientVersion));
        },
        Math.floor(1000 / EVENTS_PER_SECOND),
      );
      return async () => {
        clearInterval(interval);
        for (const s of sessions) emit(makeSessionEnd(s, ctx.clientVersion));
      };
    },
  };
}

function makeSessions(count: number): MockSession[] {
  const out: MockSession[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      sessionId: randomUUID(),
      sourceSessionId: `mock-src-${randomUUID()}`,
      seq: 0,
      cwd: `/tmp/mock/repo-${i + 1}`,
      branch: `feature/mock-${i + 1}`,
      sha: "0".repeat(40),
    });
  }
  return out;
}

function envelopeBase(
  session: MockSession,
  clientVersion: string,
): Omit<EventEnvelope, "kind" | "payload" | "event_seq" | "client_event_id"> {
  return {
    schema_version: 1,
    session_id: session.sessionId,
    source_session_id: session.sourceSessionId,
    source: SOURCE,
    source_version: SOURCE_VERSION,
    client_version: clientVersion,
    ts: new Date().toISOString(),
    cwd: session.cwd,
    git_branch: session.branch,
    git_sha: session.sha,
    model: "claude-3-5-sonnet-20241022",
    usage: null,
    duration_ms: null,
    success: null,
    raw: { mock: true },
  };
}

function makeSessionStart(session: MockSession, clientVersion: string): EventEnvelope {
  const seq = session.seq++;
  return {
    client_event_id: randomUUID(),
    ...envelopeBase(session, clientVersion),
    event_seq: seq,
    kind: "session_start",
    payload: { kind: "session_start", source_session_id: session.sourceSessionId },
  };
}

function makeSessionEnd(session: MockSession, clientVersion: string): EventEnvelope {
  const seq = session.seq++;
  return {
    client_event_id: randomUUID(),
    ...envelopeBase(session, clientVersion),
    event_seq: seq,
    kind: "session_end",
    payload: {
      kind: "session_end",
      source_session_id: session.sourceSessionId,
      reason: "mock_stop",
    },
  };
}

function makeStep(session: MockSession, clientVersion: string): EventEnvelope {
  const seq = session.seq++;
  const roll = Math.random();
  if (roll < 0.4) {
    return {
      client_event_id: randomUUID(),
      ...envelopeBase(session, clientVersion),
      event_seq: seq,
      kind: "user_prompt",
      payload: { kind: "user_prompt", text: mockPrompt(seq) },
    };
  }
  if (roll < 0.8) {
    return {
      client_event_id: randomUUID(),
      ...envelopeBase(session, clientVersion),
      event_seq: seq,
      kind: "assistant_response",
      payload: {
        kind: "assistant_response",
        text: mockResponse(seq),
        stop_reason: "end_turn",
      },
      usage: {
        input_tokens: 100 + (seq % 50),
        output_tokens: 50 + (seq % 40),
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      duration_ms: 400 + (seq % 200),
      success: true,
    };
  }
  const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
  return {
    client_event_id: randomUUID(),
    ...envelopeBase(session, clientVersion),
    event_seq: seq,
    kind: "tool_call",
    payload: {
      kind: "tool_call",
      tool_name: "bash",
      tool_input: { command: `echo mock-${seq}` },
      tool_use_id: toolUseId,
    },
  };
}

function mockPrompt(seq: number): string {
  return `Can you help me refactor the foo module? (step ${seq})`;
}

function mockResponse(seq: number): string {
  return `Sure — here's a suggestion at step ${seq}.`;
}

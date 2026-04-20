import { randomUUID } from "node:crypto";
import type { EventEnvelope, EventKind, Usage } from "@bematist/contracts";

export const SOURCE = "claude-code" as const;
export const SOURCE_VERSION = "claude-code-jsonl-v1";

export interface RawClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface RawClaudeContentBlock {
  type?: string;
  name?: string;
  input?: unknown;
  id?: string;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface RawClaudeSessionLine {
  type?: string;
  uuid?: string;
  requestId?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  message?: {
    role?: "user" | "assistant" | "system";
    content?: string | RawClaudeContentBlock[] | unknown;
    usage?: RawClaudeUsage;
    model?: string;
    stop_reason?: string | null;
    id?: string;
  };
}

export interface ParseContext {
  clientSessionId: string;
  clientVersion: string;
  nextSeq: () => number;
  isDuplicate: (uuid: string) => boolean;
  gitSha: () => string | null;
}

export function parseLineToEnvelopes(raw: string, ctx: ParseContext): EventEnvelope[] {
  let line: RawClaudeSessionLine;
  try {
    line = JSON.parse(raw) as RawClaudeSessionLine;
  } catch {
    return [];
  }
  if (!line || typeof line !== "object") return [];
  if (line.type !== "user" && line.type !== "assistant") return [];

  const uuid = typeof line.uuid === "string" ? line.uuid : null;
  if (!uuid) return [];
  if (ctx.isDuplicate(uuid)) return [];

  const ts = normalizeTimestamp(line.timestamp);
  const sourceSessionId = typeof line.sessionId === "string" ? line.sessionId : ctx.clientSessionId;
  const cwd = typeof line.cwd === "string" ? line.cwd : null;
  const gitBranch = typeof line.gitBranch === "string" ? line.gitBranch : null;
  const gitSha = ctx.gitSha();
  const sourceVersion = typeof line.version === "string" ? line.version : SOURCE_VERSION;
  const model = typeof line.message?.model === "string" ? line.message.model : null;

  const base = {
    schema_version: 1 as const,
    session_id: ctx.clientSessionId,
    source_session_id: sourceSessionId,
    source: SOURCE,
    source_version: sourceVersion,
    client_version: ctx.clientVersion,
    ts,
    cwd,
    git_branch: gitBranch,
    git_sha: gitSha,
    duration_ms: null,
    success: null,
  } as const;

  const envelopes: EventEnvelope[] = [];

  if (line.type === "user") {
    const content = line.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_result") {
          const toolOutput = block.content ?? null;
          envelopes.push({
            ...base,
            client_event_id: randomUUID(),
            event_seq: ctx.nextSeq(),
            model: null,
            usage: null,
            raw: line,
            kind: "tool_result" satisfies EventKind,
            payload: {
              kind: "tool_result",
              tool_name: findToolNameFor(block.tool_use_id) ?? "unknown",
              tool_output: toolOutput,
              tool_use_id: typeof block.tool_use_id === "string" ? block.tool_use_id : null,
              is_error: typeof block.is_error === "boolean" ? block.is_error : null,
            },
            success: block.is_error === true ? false : block.is_error === false ? true : null,
          });
        }
      }
    } else if (typeof content === "string") {
      envelopes.push({
        ...base,
        client_event_id: randomUUID(),
        event_seq: ctx.nextSeq(),
        model: null,
        usage: null,
        raw: line,
        kind: "user_prompt" satisfies EventKind,
        payload: { kind: "user_prompt", text: content },
      });
    }
    return envelopes;
  }

  const content = line.message?.content;
  const usage = normalizeUsage(line.message?.usage);
  const textParts: string[] = [];
  const toolUses: Array<{ id: string | null; name: string; input: unknown }> = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block?.type === "tool_use") {
        toolUses.push({
          id: typeof block.id === "string" ? block.id : null,
          name: typeof block.name === "string" ? block.name : "unknown",
          input: block.input ?? null,
        });
      }
    }
  }

  const assistantText = textParts.join("");
  const stopReason =
    typeof line.message?.stop_reason === "string" ? line.message.stop_reason : null;

  envelopes.push({
    ...base,
    client_event_id: randomUUID(),
    event_seq: ctx.nextSeq(),
    model,
    usage,
    raw: line,
    kind: "assistant_response" satisfies EventKind,
    payload: {
      kind: "assistant_response",
      text: assistantText,
      stop_reason: stopReason,
    },
  });

  for (const tu of toolUses) {
    envelopes.push({
      ...base,
      client_event_id: randomUUID(),
      event_seq: ctx.nextSeq(),
      model,
      usage: null,
      raw: line,
      kind: "tool_call" satisfies EventKind,
      payload: {
        kind: "tool_call",
        tool_name: tu.name,
        tool_input: tu.input,
        tool_use_id: tu.id,
      },
    });
  }

  return envelopes;
}

function normalizeUsage(u: RawClaudeUsage | undefined): Usage | null {
  if (!u || typeof u !== "object") return null;
  return {
    input_tokens: nonNegInt(u.input_tokens),
    output_tokens: nonNegInt(u.output_tokens),
    cache_read_tokens: nonNegInt(u.cache_read_input_tokens),
    cache_creation_tokens: nonNegInt(u.cache_creation_input_tokens),
  };
}

function nonNegInt(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function normalizeTimestamp(ts: string | undefined): string {
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function findToolNameFor(_toolUseId: string | undefined): string | null {
  return null;
}

export function makeSessionStartEnvelope(ctx: {
  clientSessionId: string;
  sourceSessionId: string;
  clientVersion: string;
  cwd: string | null;
  gitBranch: string | null;
  gitSha: string | null;
  sourceVersion: string;
  ts: string;
  seq: number;
}): EventEnvelope {
  return {
    client_event_id: randomUUID(),
    schema_version: 1,
    session_id: ctx.clientSessionId,
    source_session_id: ctx.sourceSessionId,
    source: SOURCE,
    source_version: ctx.sourceVersion,
    client_version: ctx.clientVersion,
    ts: ctx.ts,
    event_seq: ctx.seq,
    cwd: ctx.cwd,
    git_branch: ctx.gitBranch,
    git_sha: ctx.gitSha,
    model: null,
    usage: null,
    duration_ms: null,
    success: null,
    raw: { synthetic: "session_start" },
    kind: "session_start",
    payload: { kind: "session_start", source_session_id: ctx.sourceSessionId },
  };
}

export function makeSessionEndEnvelope(ctx: {
  clientSessionId: string;
  sourceSessionId: string;
  clientVersion: string;
  cwd: string | null;
  gitBranch: string | null;
  gitSha: string | null;
  sourceVersion: string;
  ts: string;
  seq: number;
  reason: string | null;
}): EventEnvelope {
  return {
    client_event_id: randomUUID(),
    schema_version: 1,
    session_id: ctx.clientSessionId,
    source_session_id: ctx.sourceSessionId,
    source: SOURCE,
    source_version: ctx.sourceVersion,
    client_version: ctx.clientVersion,
    ts: ctx.ts,
    event_seq: ctx.seq,
    cwd: ctx.cwd,
    git_branch: ctx.gitBranch,
    git_sha: ctx.gitSha,
    model: null,
    usage: null,
    duration_ms: null,
    success: null,
    raw: { synthetic: "session_end", reason: ctx.reason },
    kind: "session_end",
    payload: { kind: "session_end", source_session_id: ctx.sourceSessionId, reason: ctx.reason },
  };
}

import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@bematist/contracts";
import { z } from "zod";

export const CURSOR_HOOK_EVENTS = [
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "preToolUse",
  "postToolUse",
  "afterShellExecution",
  "afterFileEdit",
  "sessionStart",
  "sessionEnd",
] as const;

export type CursorHookEvent = (typeof CURSOR_HOOK_EVENTS)[number];

const HookInputSchema = z
  .object({
    hook_event_name: z.string(),
  })
  .passthrough();

export type HookInput = z.infer<typeof HookInputSchema>;

export interface NormalizeContext {
  clientVersion: string;
  sourceVersion?: string;
  seqFor: (sessionKey: string) => number;
  now?: () => string;
}

export interface NormalizeResult {
  event: EventEnvelope;
  sessionKey: string;
}

export function parseHookInput(raw: string): HookInput {
  const parsed = JSON.parse(raw);
  return HookInputSchema.parse(parsed);
}

export function normalize(input: HookInput, ctx: NormalizeContext): NormalizeResult {
  const name = input.hook_event_name;
  if (!isCursorHookEvent(name)) {
    throw new Error(`unknown cursor hook event: ${name}`);
  }

  const sourceSessionId = pickString(input, "session_id", "sessionId") ?? "cursor-unknown";
  const sessionUuid = pickUuid(input, "bematist_session_id") ?? deriveSessionUuid(sourceSessionId);
  const cwd = pickString(input, "cwd", "workspace_root");
  const gitBranch = pickString(input, "git_branch", "branch");
  const gitSha = pickString(input, "git_sha", "sha");
  const model = pickString(input, "model");
  const usage = pickUsage(input);
  const durationMs = pickNumber(input, "duration_ms", "durationMs");
  const success = pickBool(input, "success", "ok");
  const ts = ctx.now?.() ?? new Date().toISOString();

  const base = {
    client_event_id: randomUUID(),
    schema_version: 1 as const,
    session_id: sessionUuid,
    source_session_id: sourceSessionId,
    source: "cursor" as const,
    source_version: ctx.sourceVersion ?? "cursor-hook-1",
    client_version: ctx.clientVersion,
    ts,
    event_seq: ctx.seqFor(sessionUuid),
    cwd: cwd ?? null,
    git_branch: gitBranch ?? null,
    git_sha: gitSha ?? null,
    model: model ?? null,
    usage,
    duration_ms: durationMs,
    success,
    raw: input,
  };

  const event = buildPayload(name, input, sourceSessionId, base);
  return { event, sessionKey: sessionUuid };
}

type Base = Omit<EventEnvelope, "kind" | "payload">;

function buildPayload(
  name: CursorHookEvent,
  input: HookInput,
  sourceSessionId: string,
  base: Base,
): EventEnvelope {
  switch (name) {
    case "beforeSubmitPrompt": {
      const text = pickString(input, "prompt", "text", "input") ?? "";
      return { ...base, kind: "user_prompt", payload: { kind: "user_prompt", text } };
    }
    case "afterAgentResponse": {
      const text = pickString(input, "response", "text", "output") ?? "";
      const stopReason = pickString(input, "stop_reason", "stopReason") ?? null;
      return {
        ...base,
        kind: "assistant_response",
        payload: { kind: "assistant_response", text, stop_reason: stopReason },
      };
    }
    case "preToolUse": {
      const toolName = pickString(input, "tool_name", "toolName") ?? "unknown";
      const toolInput = pickUnknown(input, "tool_input", "toolInput", "input");
      const toolUseId = pickString(input, "tool_use_id", "toolUseId") ?? null;
      return {
        ...base,
        kind: "tool_call",
        payload: {
          kind: "tool_call",
          tool_name: toolName,
          tool_input: toolInput,
          tool_use_id: toolUseId,
        },
      };
    }
    case "postToolUse": {
      const toolName = pickString(input, "tool_name", "toolName") ?? "unknown";
      const toolOutput = pickUnknown(input, "tool_output", "toolOutput", "output", "result");
      const toolUseId = pickString(input, "tool_use_id", "toolUseId") ?? null;
      const isError = pickBool(input, "is_error", "isError");
      return {
        ...base,
        kind: "tool_result",
        payload: {
          kind: "tool_result",
          tool_name: toolName,
          tool_output: toolOutput,
          tool_use_id: toolUseId,
          is_error: isError,
        },
      };
    }
    case "afterShellExecution": {
      const toolOutput = pickUnknown(input, "output", "stdout", "result");
      const toolUseId = pickString(input, "tool_use_id", "toolUseId") ?? null;
      const isError = pickBool(input, "is_error", "isError");
      return {
        ...base,
        kind: "tool_result",
        payload: {
          kind: "tool_result",
          tool_name: "shell",
          tool_output: toolOutput,
          tool_use_id: toolUseId,
          is_error: isError,
        },
      };
    }
    case "afterFileEdit": {
      const toolOutput = pickUnknown(input, "diff", "changes", "result");
      const toolUseId = pickString(input, "tool_use_id", "toolUseId") ?? null;
      return {
        ...base,
        kind: "tool_result",
        payload: {
          kind: "tool_result",
          tool_name: "edit",
          tool_output: toolOutput,
          tool_use_id: toolUseId,
          is_error: null,
        },
      };
    }
    case "sessionStart": {
      return {
        ...base,
        kind: "session_start",
        payload: { kind: "session_start", source_session_id: sourceSessionId },
      };
    }
    case "sessionEnd": {
      const reason = pickString(input, "reason") ?? null;
      return {
        ...base,
        kind: "session_end",
        payload: { kind: "session_end", source_session_id: sourceSessionId, reason },
      };
    }
  }
}

function isCursorHookEvent(name: string): name is CursorHookEvent {
  return (CURSOR_HOOK_EVENTS as readonly string[]).includes(name);
}

function pickString(obj: HookInput, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function pickNumber(obj: HookInput, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  }
  return null;
}

function pickBool(obj: HookInput, ...keys: string[]): boolean | null {
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v === "boolean") return v;
  }
  return null;
}

function pickUnknown(obj: HookInput, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (v !== undefined) return v;
  }
  return null;
}

function pickUuid(obj: HookInput, key: string): string | undefined {
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    ? v
    : undefined;
}

function pickUsage(obj: HookInput): EventEnvelope["usage"] {
  const u = (obj as Record<string, unknown>).usage;
  if (!u || typeof u !== "object") return null;
  const r = u as Record<string, unknown>;
  const toNum = (x: unknown) =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
  const input_tokens = toNum(r.input_tokens ?? r.inputTokens);
  const output_tokens = toNum(r.output_tokens ?? r.outputTokens);
  const cache_read_tokens = toNum(r.cache_read_tokens ?? r.cacheReadTokens);
  const cache_creation_tokens = toNum(r.cache_creation_tokens ?? r.cacheCreationTokens);
  if (
    input_tokens === 0 &&
    output_tokens === 0 &&
    cache_read_tokens === 0 &&
    cache_creation_tokens === 0
  ) {
    return null;
  }
  return { input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens };
}

function deriveSessionUuid(sourceSessionId: string): string {
  const ns = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  return uuidV5(sourceSessionId, ns);
}

function uuidV5(name: string, namespace: string): string {
  const nsBytes = parseUuid(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const buf = new Uint8Array(nsBytes.length + nameBytes.length);
  buf.set(nsBytes, 0);
  buf.set(nameBytes, nsBytes.length);
  const hash = sha1(buf);
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  return formatUuid(hash.slice(0, 16));
}

function parseUuid(s: string): Uint8Array {
  const hex = s.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function formatUuid(b: Uint8Array): string {
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function sha1(data: Uint8Array): Uint8Array {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(data);
  const buf = hasher.digest();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

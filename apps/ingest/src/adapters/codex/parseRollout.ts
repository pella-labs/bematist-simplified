export interface CodexTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  total_tokens: number;
}

export const ZERO_USAGE: CodexTokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cached_input_tokens: 0,
  total_tokens: 0,
};

export interface CodexSessionMetaRecord {
  kind: "session_meta";
  timestamp: string | null;
  source_session_id: string | null;
  cwd: string | null;
  model: string | null;
  cli_version: string | null;
  raw: unknown;
}

export interface CodexTurnContextRecord {
  kind: "turn_context";
  timestamp: string | null;
  turn_id: string | null;
  cwd: string | null;
  model: string | null;
  raw: unknown;
}

export interface CodexMessageRecord {
  kind: "user_message" | "assistant_message";
  timestamp: string | null;
  turn_id: string | null;
  role: "user" | "assistant";
  text: string;
  model: string | null;
  stop_reason: string | null;
  raw: unknown;
}

export interface CodexToolCallRecord {
  kind: "tool_call";
  timestamp: string | null;
  turn_id: string | null;
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string | null;
  raw: unknown;
}

export interface CodexToolResultRecord {
  kind: "tool_result";
  timestamp: string | null;
  turn_id: string | null;
  tool_name: string;
  tool_output: unknown;
  tool_use_id: string | null;
  is_error: boolean | null;
  raw: unknown;
}

export interface CodexTokenCountRecord {
  kind: "token_count";
  timestamp: string | null;
  turn_id: string | null;
  model: string | null;
  cumulative: CodexTokenUsage;
  raw: unknown;
}

export interface CodexSessionEndRecord {
  kind: "session_end";
  timestamp: string | null;
  raw: unknown;
}

export type CodexRecord =
  | CodexSessionMetaRecord
  | CodexTurnContextRecord
  | CodexMessageRecord
  | CodexToolCallRecord
  | CodexToolResultRecord
  | CodexTokenCountRecord
  | CodexSessionEndRecord;

export interface ParseOutcome {
  record: CodexRecord | null;
  skipped?: "malformed" | "unknown_kind" | "empty_token_count" | "empty_line";
}

export function parseRolloutLine(raw: string): ParseOutcome {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { record: null, skipped: "empty_line" };
  let parsed: UnknownObject;
  try {
    const any = JSON.parse(trimmed);
    if (!any || typeof any !== "object" || Array.isArray(any)) {
      return { record: null, skipped: "malformed" };
    }
    parsed = any as UnknownObject;
  } catch {
    return { record: null, skipped: "malformed" };
  }

  const timestamp = pickString(parsed.timestamp);
  const kind = extractKind(parsed);
  const payload = extractPayload(parsed);
  const turnId = pickString(parsed.turn_id) ?? pickString(payload?.turn_id);

  if (kind === "session_meta") {
    const p = (payload ?? parsed) as UnknownObject;
    return {
      record: {
        kind: "session_meta",
        timestamp,
        source_session_id: pickString(p.id) ?? pickString(parsed.session_id),
        cwd: pickString(p.cwd),
        model: pickString(p.model) ?? pickString(p.model_provider),
        cli_version: pickString(p.cli_version),
        raw: parsed,
      },
    };
  }

  if (kind === "session_end" || kind === "session_stop") {
    return {
      record: { kind: "session_end", timestamp, raw: parsed },
    };
  }

  if (kind === "turn_context") {
    const p = payload ?? {};
    const model =
      pickString(nested(p, ["collaboration_mode", "settings", "model"])) ?? pickString(p.model);
    return {
      record: {
        kind: "turn_context",
        timestamp,
        turn_id: turnId,
        cwd: pickString(p.cwd),
        model,
        raw: parsed,
      },
    };
  }

  if (kind === "user_message" || kind === "assistant_message" || kind === "agent_message") {
    const p = payload ?? {};
    const role: "user" | "assistant" =
      kind === "user_message" ? "user" : pickString(p.role) === "user" ? "user" : "assistant";
    const text = extractText(p.content);
    return {
      record: {
        kind: role === "user" ? "user_message" : "assistant_message",
        timestamp,
        turn_id: turnId,
        role,
        text,
        model: pickString(p.model),
        stop_reason: pickString(p.finish_reason) ?? pickString(p.stop_reason),
        raw: parsed,
      },
    };
  }

  if (
    kind === "exec_command_start" ||
    kind === "exec_command_end" ||
    kind === "patch_apply_start" ||
    kind === "patch_apply_end" ||
    kind === "tool_call"
  ) {
    const p = payload ?? {};
    const isEnd = kind === "exec_command_end" || kind === "patch_apply_end";
    const toolName = deriveToolName(kind, p);
    const toolUseId = pickString(p.call_id) ?? pickString(p.tool_use_id) ?? turnId;
    if (isEnd) {
      const exitCode = typeof p.exit_code === "number" ? p.exit_code : null;
      const isError =
        typeof p.success === "boolean" ? !p.success : exitCode !== null ? exitCode !== 0 : null;
      return {
        record: {
          kind: "tool_result",
          timestamp,
          turn_id: turnId,
          tool_name: toolName,
          tool_output: {
            exit_code: exitCode,
            duration_ms: typeof p.duration_ms === "number" ? p.duration_ms : null,
            stdout_bytes: typeof p.stdout_bytes === "number" ? p.stdout_bytes : null,
            stderr_bytes: typeof p.stderr_bytes === "number" ? p.stderr_bytes : null,
            path: pickString(p.path),
            success: typeof p.success === "boolean" ? p.success : null,
            hunk_count: typeof p.hunk_count === "number" ? p.hunk_count : null,
          },
          tool_use_id: toolUseId,
          is_error: isError,
          raw: parsed,
        },
      };
    }
    return {
      record: {
        kind: "tool_call",
        timestamp,
        turn_id: turnId,
        tool_name: toolName,
        tool_input:
          kind === "patch_apply_start"
            ? { path: pickString(p.path) }
            : { command: pickString(p.command) ?? null, cwd: pickString(p.cwd) },
        tool_use_id: toolUseId,
        raw: parsed,
      },
    };
  }

  if (kind === "token_count") {
    const p = payload ?? {};
    if (p.info === null) {
      return { record: null, skipped: "empty_token_count" };
    }
    const cumulative = snapshotFromTokenPayload(p);
    if (!hasAnyUsage(cumulative)) {
      return { record: null, skipped: "empty_token_count" };
    }
    return {
      record: {
        kind: "token_count",
        timestamp,
        turn_id: turnId,
        model: pickString(p.model),
        cumulative,
        raw: parsed,
      },
    };
  }

  return { record: null, skipped: "unknown_kind" };
}

export function extractKind(line: UnknownObject): string | undefined {
  const inner = asObject(line.event_msg);
  if (inner) {
    const t = pickString(inner.type);
    if (t) return t;
  }
  const outer = pickString(line.type);
  if (outer === "event_msg") {
    const payload = asObject(line.payload);
    const inner2 = pickString(payload?.type);
    if (inner2) return inner2;
    return undefined;
  }
  return outer ?? undefined;
}

export function extractPayload(line: UnknownObject): UnknownObject | undefined {
  if (line.type === "event_msg") {
    const p = asObject(line.payload);
    if (p) return p;
  }
  const inner = asObject(line.event_msg);
  const innerPayload = asObject(inner?.payload);
  if (innerPayload) return innerPayload;
  return asObject(line.payload);
}

function snapshotFromTokenPayload(p: UnknownObject): CodexTokenUsage {
  const info = asObject(p.info);
  const total = asObject(info?.total_token_usage);
  if (total) {
    return {
      input_tokens: pickNumber(total.input_tokens),
      output_tokens: pickNumber(total.output_tokens),
      cached_input_tokens: pickNumber(total.cached_input_tokens),
      total_tokens: pickNumber(total.total_tokens),
    };
  }
  return {
    input_tokens: pickNumber(p.input_tokens),
    output_tokens: pickNumber(p.output_tokens),
    cached_input_tokens: pickNumber(p.cached_input_tokens),
    total_tokens: pickNumber(p.total_tokens),
  };
}

function hasAnyUsage(u: CodexTokenUsage): boolean {
  return (
    u.input_tokens > 0 || u.output_tokens > 0 || u.cached_input_tokens > 0 || u.total_tokens > 0
  );
}

function deriveToolName(kind: string, p: UnknownObject): string {
  if (kind === "patch_apply_start" || kind === "patch_apply_end") return "apply_patch";
  if (kind === "tool_call") return pickString(p.tool_name) ?? "tool";
  const command = pickString(p.command);
  if (!command) return "shell";
  const first = command
    .trim()
    .split(/\s+/, 1)[0]
    ?.replace(/^['"]+|['"]+$/g, "");
  if (!first) return "shell";
  const base = first.split("/").pop() ?? first;
  if (!/^[A-Za-z0-9_.+-]+$/.test(base)) return "shell";
  return base;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (typeof c === "string") parts.push(c);
      else if (c && typeof c === "object") {
        const obj = c as UnknownObject;
        const txt = pickString(obj.text);
        if (txt) parts.push(txt);
      }
    }
    return parts.join("");
  }
  if (content && typeof content === "object") {
    const txt = pickString((content as UnknownObject).text);
    if (txt) return txt;
  }
  return "";
}

type UnknownObject = Record<string, unknown>;

function asObject(v: unknown): UnknownObject | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as UnknownObject;
  return undefined;
}

function pickString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function pickNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function nested(obj: UnknownObject, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as UnknownObject)[k];
  }
  return cur;
}

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { EventEnvelope } from "@bematist/contracts";
import type { AdapterContext } from "../types";
import {
  type CodexMessageRecord,
  type CodexRecord,
  type CodexToolCallRecord,
  type CodexToolResultRecord,
  parseRolloutLine,
} from "./parseRollout";
import { TokenDiffer } from "./tokenDiff";

const SOURCE_VERSION = "codex-cli";

export interface HistoricalFile {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface EnumerateOptions {
  root: string;
  sinceMs: number;
}

export async function enumerateHistoricalFiles(opts: EnumerateOptions): Promise<HistoricalFile[]> {
  const out: HistoricalFile[] = [];
  await walk(opts.root, opts.sinceMs, out);
  return out;
}

async function walk(dir: string, sinceMs: number, out: HistoricalFile[]): Promise<void> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as unknown as Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(p, sinceMs, out);
      continue;
    }
    if (!e.isFile()) continue;
    if (!(e.name.startsWith("rollout-") && e.name.endsWith(".jsonl"))) continue;
    try {
      const s = await stat(p);
      if (s.mtimeMs < sinceMs) continue;
      out.push({ path: p, mtimeMs: s.mtimeMs, sizeBytes: s.size });
    } catch {
      // unreadable — skip
    }
  }
}

interface FileState {
  clientSessionId: string;
  sourceSessionId: string | null;
  cwd: string | null;
  activeModel: string | null;
  gitBranch: string | null;
  gitSha: string | null;
  eventSeq: number;
  differ: TokenDiffer;
  sessionStartEmitted: boolean;
  sessionEndEmitted: boolean;
  lastAssistantTurn: string | null;
}

function sessionIdFromPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  const m = name.match(/^rollout-([A-Za-z0-9_-]+)\.jsonl$/);
  if (m?.[1]) return m[1];
  return name.replace(/\.jsonl$/, "");
}

function normalizeTs(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

export async function* readFileToEnvelopes(
  path: string,
  ctx: AdapterContext,
): AsyncIterable<EventEnvelope> {
  const state: FileState = {
    clientSessionId: randomUUID(),
    sourceSessionId: null,
    cwd: null,
    activeModel: null,
    gitBranch: null,
    gitSha: null,
    eventSeq: 0,
    differ: new TokenDiffer(),
    sessionStartEmitted: false,
    sessionEndEmitted: false,
    lastAssistantTurn: null,
  };

  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  let sawAnyLine = false;

  function buildEnvelope(
    timestamp: string | null,
    kind: EventEnvelope["kind"],
    payload: EventEnvelope["payload"],
    raw: unknown,
  ): EventEnvelope {
    const seq = state.eventSeq++;
    return {
      client_event_id: randomUUID(),
      schema_version: 1,
      session_id: state.clientSessionId,
      source_session_id: state.sourceSessionId ?? sessionIdFromPath(path),
      source: "codex",
      source_version: SOURCE_VERSION,
      client_version: ctx.clientVersion,
      ts: normalizeTs(timestamp) ?? new Date().toISOString(),
      event_seq: seq,
      kind,
      payload,
      cwd: state.cwd,
      git_branch: state.gitBranch,
      git_sha: state.gitSha,
      model: state.activeModel,
      usage: null,
      duration_ms: null,
      success: null,
      raw,
    };
  }

  function* ensureSessionStart(timestamp: string | null): Generator<EventEnvelope> {
    if (state.sessionStartEmitted) return;
    state.sourceSessionId = state.sourceSessionId ?? sessionIdFromPath(path);
    yield buildEnvelope(
      timestamp,
      "session_start",
      {
        kind: "session_start",
        source_session_id: state.sourceSessionId,
      },
      { synthesized: true },
    );
    state.sessionStartEmitted = true;
  }

  function* handleRecord(record: CodexRecord): Generator<EventEnvelope> {
    switch (record.kind) {
      case "session_meta": {
        state.sourceSessionId = record.source_session_id ?? sessionIdFromPath(path);
        state.cwd = record.cwd;
        if (record.model) state.activeModel = record.model;
        state.differ.reset();
        yield buildEnvelope(
          record.timestamp,
          "session_start",
          {
            kind: "session_start",
            source_session_id: state.sourceSessionId,
          },
          record.raw,
        );
        state.sessionStartEmitted = true;
        return;
      }
      case "turn_context": {
        if (record.cwd) state.cwd = record.cwd;
        if (record.model) state.activeModel = record.model;
        return;
      }
      case "user_message": {
        yield* ensureSessionStart(record.timestamp);
        yield buildEnvelope(
          record.timestamp,
          "user_prompt",
          {
            kind: "user_prompt",
            text: (record as CodexMessageRecord).text,
          },
          record.raw,
        );
        return;
      }
      case "assistant_message": {
        yield* ensureSessionStart(record.timestamp);
        const msg = record as CodexMessageRecord;
        const usedModel = msg.model ?? state.activeModel;
        if (usedModel) state.activeModel = usedModel;
        yield buildEnvelope(
          record.timestamp,
          "assistant_response",
          {
            kind: "assistant_response",
            text: msg.text,
            stop_reason: msg.stop_reason,
          },
          record.raw,
        );
        state.lastAssistantTurn = msg.turn_id;
        return;
      }
      case "tool_call": {
        yield* ensureSessionStart(record.timestamp);
        const tc = record as CodexToolCallRecord;
        yield buildEnvelope(
          record.timestamp,
          "tool_call",
          {
            kind: "tool_call",
            tool_name: tc.tool_name,
            tool_input: tc.tool_input,
            tool_use_id: tc.tool_use_id,
          },
          record.raw,
        );
        return;
      }
      case "tool_result": {
        yield* ensureSessionStart(record.timestamp);
        const tr = record as CodexToolResultRecord;
        yield buildEnvelope(
          record.timestamp,
          "tool_result",
          {
            kind: "tool_result",
            tool_name: tr.tool_name,
            tool_output: tr.tool_output,
            tool_use_id: tr.tool_use_id,
            is_error: tr.is_error,
          },
          record.raw,
        );
        return;
      }
      case "token_count": {
        yield* ensureSessionStart(record.timestamp);
        const { delta } = state.differ.observe(record.cumulative);
        if (
          delta.input_tokens === 0 &&
          delta.output_tokens === 0 &&
          delta.cached_input_tokens === 0 &&
          delta.total_tokens === 0
        ) {
          return;
        }
        const usage = {
          input_tokens: delta.input_tokens,
          output_tokens: delta.output_tokens,
          cache_read_tokens: delta.cached_input_tokens,
          cache_creation_tokens: 0,
        };
        const model = record.model ?? state.activeModel;
        const env = buildEnvelope(
          record.timestamp,
          "assistant_response",
          {
            kind: "assistant_response",
            text: "",
            stop_reason: "token_count",
          },
          record.raw,
        );
        env.usage = usage;
        if (model) env.model = model;
        yield env;
        return;
      }
      case "session_end": {
        if (!state.sessionStartEmitted) return;
        yield buildEnvelope(
          record.timestamp,
          "session_end",
          {
            kind: "session_end",
            source_session_id: state.sourceSessionId ?? sessionIdFromPath(path),
            reason: "session_end",
          },
          record.raw,
        );
        state.sessionEndEmitted = true;
        return;
      }
    }
  }

  try {
    for await (const rawLine of rl) {
      const line = stripBom(rawLine).trim();
      if (line.length === 0) continue;
      sawAnyLine = true;
      const outcome = parseRolloutLine(line);
      if (!outcome.record) continue;
      yield* handleRecord(outcome.record);
    }
  } finally {
    rl.close();
    stream.close();
  }

  if (sawAnyLine && state.sessionStartEmitted && !state.sessionEndEmitted) {
    yield buildEnvelope(
      null,
      "session_end",
      {
        kind: "session_end",
        source_session_id: state.sourceSessionId ?? sessionIdFromPath(path),
        reason: "backfill",
      },
      { synthesized: true },
    );
  }
}

function stripBom(s: string): string {
  if (s.length > 0 && s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}

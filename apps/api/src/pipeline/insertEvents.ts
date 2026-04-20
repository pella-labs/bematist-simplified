import type { EventBatch, EventEnvelope } from "@bematist/contracts";
import type { Sql } from "postgres";
import { computeCost } from "./cost";

export interface InsertResult {
  accepted: number;
  deduped: number;
}

const EVENTS_COLUMNS = [
  "client_event_id",
  "org_id",
  "developer_id",
  "session_id",
  "event_seq",
  "ts",
  "kind",
  "tool_name",
  "tool_input",
  "tool_output",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "cost_usd",
  "duration_ms",
  "success",
  "raw",
] as const;

interface EventRow {
  client_event_id: string;
  org_id: string;
  developer_id: string;
  session_id: string;
  event_seq: number;
  ts: Date;
  kind: string;
  tool_name: string | null;
  tool_input: unknown;
  tool_output: unknown;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  success: boolean | null;
  raw: unknown;
}

function extractTool(envelope: EventEnvelope): {
  tool_name: string | null;
  tool_input: unknown;
  tool_output: unknown;
} {
  const payload = envelope.payload;
  if (payload.kind === "tool_call") {
    return { tool_name: payload.tool_name, tool_input: payload.tool_input, tool_output: null };
  }
  if (payload.kind === "tool_result") {
    return { tool_name: payload.tool_name, tool_input: null, tool_output: payload.tool_output };
  }
  return { tool_name: null, tool_input: null, tool_output: null };
}

type GroupKey = string;

function groupKey(envelope: EventEnvelope): GroupKey {
  return `${envelope.source}\u0000${envelope.source_session_id}`;
}

interface SessionGroup {
  source: EventEnvelope["source"];
  source_session_id: string;
  started_at: Date;
  ended_at: Date;
  cwd: string | null;
  git_branch: string | null;
  git_sha_at_start: string | null;
  model_hint: string | null;
  client_version: string;
  envelopes: EventEnvelope[];
}

function groupBySession(batch: EventBatch): Map<GroupKey, SessionGroup> {
  const groups = new Map<GroupKey, SessionGroup>();
  for (const envelope of batch) {
    const key = groupKey(envelope);
    const ts = new Date(envelope.ts);
    const existing = groups.get(key);
    if (existing) {
      existing.envelopes.push(envelope);
      if (ts < existing.started_at) existing.started_at = ts;
      if (ts > existing.ended_at) existing.ended_at = ts;
    } else {
      groups.set(key, {
        source: envelope.source,
        source_session_id: envelope.source_session_id,
        started_at: ts,
        ended_at: ts,
        cwd: envelope.cwd,
        git_branch: envelope.git_branch,
        git_sha_at_start: envelope.git_sha,
        model_hint: envelope.model,
        client_version: envelope.client_version,
        envelopes: [envelope],
      });
    }
  }
  return groups;
}

async function buildEventRow(
  sql: Sql,
  orgId: string,
  developerId: string,
  sessionId: string,
  envelope: EventEnvelope,
): Promise<EventRow> {
  const ts = new Date(envelope.ts);
  const { cost_usd } = await computeCost(sql, envelope.model, envelope.usage, ts);
  const tool = extractTool(envelope);
  return {
    client_event_id: envelope.client_event_id,
    org_id: orgId,
    developer_id: developerId,
    session_id: sessionId,
    event_seq: envelope.event_seq,
    ts,
    kind: envelope.kind,
    tool_name: tool.tool_name,
    tool_input: tool.tool_input,
    tool_output: tool.tool_output,
    input_tokens: envelope.usage?.input_tokens ?? null,
    output_tokens: envelope.usage?.output_tokens ?? null,
    cache_read_tokens: envelope.usage?.cache_read_tokens ?? null,
    cache_creation_tokens: envelope.usage?.cache_creation_tokens ?? null,
    cost_usd: envelope.usage ? cost_usd : null,
    duration_ms: envelope.duration_ms,
    success: envelope.success,
    raw: envelope.raw ?? null,
  };
}

export async function insertEvents(
  sql: Sql,
  orgId: string,
  developerId: string,
  batch: EventBatch,
): Promise<InsertResult> {
  if (batch.length === 0) return { accepted: 0, deduped: 0 };

  const groups = groupBySession(batch);

  let accepted = 0;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;

    const sessionIdByKey = new Map<GroupKey, string>();
    for (const [key, group] of groups) {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO sessions (
          org_id, developer_id, source, source_session_id,
          started_at, ended_at, cwd, git_branch, git_sha_at_start, model_hint, client_version
        ) VALUES (
          ${orgId}, ${developerId}, ${group.source}, ${group.source_session_id},
          ${group.started_at}, ${group.ended_at},
          ${group.cwd}, ${group.git_branch}, ${group.git_sha_at_start},
          ${group.model_hint}, ${group.client_version}
        )
        ON CONFLICT (org_id, source, source_session_id) DO UPDATE SET
          ended_at = GREATEST(sessions.ended_at, EXCLUDED.ended_at)
        RETURNING id
      `;
      const row = inserted[0];
      if (!row) throw new Error("session upsert returned no row");
      sessionIdByKey.set(key, row.id);
    }

    const rows: EventRow[] = [];
    for (const envelope of batch) {
      const sessionId = sessionIdByKey.get(groupKey(envelope));
      if (!sessionId) throw new Error("missing session id after upsert");
      rows.push(await buildEventRow(sql, orgId, developerId, sessionId, envelope));
    }

    const helper = tx(rows as unknown as Record<string, unknown>[], ...EVENTS_COLUMNS);
    const inserted = await tx`
      INSERT INTO events ${helper}
      ON CONFLICT (org_id, session_id, event_seq, client_event_id, ts) DO NOTHING
      RETURNING id
    `;
    accepted = inserted.count;
  });

  return { accepted, deduped: batch.length - accepted };
}

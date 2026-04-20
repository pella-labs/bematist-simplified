import type { EventBatch, EventEnvelope } from "@bematist/contracts";
import type { Sql } from "postgres";
import { computeCost } from "./cost";

export interface InsertResult {
  accepted: number;
  deduped: number;
}

const COLUMNS = [
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
  "pricing_version",
  "duration_ms",
  "success",
  "raw",
  "cwd",
  "git_branch",
  "git_sha",
  "model",
  "source",
  "source_version",
  "client_version",
  "source_session_id",
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
  pricing_version: string | null;
  duration_ms: number | null;
  success: boolean | null;
  raw: unknown;
  cwd: string | null;
  git_branch: string | null;
  git_sha: string | null;
  model: string | null;
  source: string;
  source_version: string;
  client_version: string;
  source_session_id: string;
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

async function buildRow(
  sql: Sql,
  orgId: string,
  developerId: string,
  envelope: EventEnvelope,
): Promise<EventRow> {
  const ts = new Date(envelope.ts);
  const { cost_usd, pricing_version } = await computeCost(sql, envelope.model, envelope.usage, ts);
  const tool = extractTool(envelope);
  return {
    client_event_id: envelope.client_event_id,
    org_id: orgId,
    developer_id: developerId,
    session_id: envelope.session_id,
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
    pricing_version: envelope.usage ? pricing_version : null,
    duration_ms: envelope.duration_ms,
    success: envelope.success,
    raw: envelope.raw ?? null,
    cwd: envelope.cwd,
    git_branch: envelope.git_branch,
    git_sha: envelope.git_sha,
    model: envelope.model,
    source: envelope.source,
    source_version: envelope.source_version,
    client_version: envelope.client_version,
    source_session_id: envelope.source_session_id,
  };
}

export async function insertEvents(
  sql: Sql,
  orgId: string,
  developerId: string,
  batch: EventBatch,
): Promise<InsertResult> {
  if (batch.length === 0) return { accepted: 0, deduped: 0 };

  const rows: EventRow[] = [];
  for (const envelope of batch) {
    rows.push(await buildRow(sql, orgId, developerId, envelope));
  }

  let accepted = 0;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    const helper = tx(rows as unknown as Record<string, unknown>[], ...COLUMNS);
    const inserted = await tx`
      INSERT INTO events ${helper}
      ON CONFLICT (org_id, session_id, event_seq, client_event_id) DO NOTHING
      RETURNING id
    `;
    accepted = inserted.count;
  });

  return { accepted, deduped: batch.length - accepted };
}

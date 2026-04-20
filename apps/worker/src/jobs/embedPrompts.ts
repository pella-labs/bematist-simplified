import type { EmbeddingProvider } from "@bematist/embed";
import type postgres from "postgres";

export interface EmbedPromptsOptions {
  sql: postgres.Sql;
  provider: EmbeddingProvider;
  batchSize?: number;
  maxPerTick?: number;
}

export interface EmbedPromptsResult {
  scanned: number;
  embedded: number;
  batches: number;
  failedBatches: number;
}

interface PendingRow {
  id: string;
  created_at: string;
  org_id: string;
  prompt_text: string;
}

function vectorLiteral(vec: Float32Array): string {
  const parts: string[] = [];
  for (let i = 0; i < vec.length; i++) {
    const n = vec[i] ?? 0;
    parts.push(n.toFixed(6));
  }
  return `[${parts.join(",")}]`;
}

async function fetchPending(sql: postgres.Sql, limit: number): Promise<PendingRow[]> {
  // Preserve microsecond precision on created_at by selecting it as text —
  // postgres-js downcasts timestamptz to JS Date (millisecond), which silently
  // mismatches the stored row key in the partition.
  return sql<PendingRow[]>`
    SELECT id, created_at::text AS created_at, org_id, prompt_text
    FROM prompts
    WHERE embedding IS NULL
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
}

async function writeEmbeddingsBatch(
  sql: postgres.Sql,
  rows: PendingRow[],
  embeddings: Float32Array[],
): Promise<void> {
  // One transaction per batch. Set app.current_org_id for each row's update
  // since a batch can span orgs — wrap each update in its own org scope.
  await sql.begin(async (tx) => {
    // Group rows by org to minimise set_config calls.
    const byOrg = new Map<string, Array<{ row: PendingRow; vec: Float32Array }>>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as PendingRow;
      const vec = embeddings[i] as Float32Array;
      let bucket = byOrg.get(row.org_id);
      if (!bucket) {
        bucket = [];
        byOrg.set(row.org_id, bucket);
      }
      bucket.push({ row, vec });
    }
    for (const [orgId, items] of byOrg) {
      await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      for (const { row, vec } of items) {
        const literal = vectorLiteral(vec);
        // created_at is included so Postgres can prune partitions, but compared
        // via ::text because postgres-js truncates JS Dates to millisecond
        // precision when binding to a timestamptz parameter.
        await tx`
          UPDATE prompts
          SET embedding = ${literal}::vector(384)
          WHERE id = ${row.id} AND created_at::text = ${row.created_at}
        `;
      }
    }
  });
}

export async function runEmbedOnce(options: EmbedPromptsOptions): Promise<EmbedPromptsResult> {
  const { sql, provider, batchSize = 32, maxPerTick = 300 } = options;
  const pending = await fetchPending(sql, maxPerTick);
  if (pending.length === 0) {
    return { scanned: 0, embedded: 0, batches: 0, failedBatches: 0 };
  }

  let embedded = 0;
  let batches = 0;
  let failedBatches = 0;

  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const slice = pending.slice(offset, offset + batchSize);
    batches++;
    try {
      const vectors = await provider.embedBatch(slice.map((r) => r.prompt_text));
      if (vectors.length !== slice.length) {
        throw new Error(`provider returned ${vectors.length} vectors for ${slice.length} inputs`);
      }
      await writeEmbeddingsBatch(sql, slice, vectors);
      embedded += slice.length;
    } catch (err) {
      failedBatches++;
      console.error(`[worker/embed] batch failed (size=${slice.length}):`, err);
    }
  }

  return { scanned: pending.length, embedded, batches, failedBatches };
}

export interface EmbedLoopHandle {
  stop: () => Promise<void>;
}

export function startEmbedLoop(
  options: EmbedPromptsOptions & { intervalMs: number },
): EmbedLoopHandle {
  const { intervalMs } = options;
  let stopped = false;
  let inFlight: Promise<EmbedPromptsResult> | null = null;

  const tick = async () => {
    if (stopped) return;
    if (inFlight) return;
    inFlight = runEmbedOnce(options).catch((err) => {
      console.error("[worker/embed] tick failed:", err);
      return { scanned: 0, embedded: 0, batches: 0, failedBatches: 0 };
    });
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);

  return {
    async stop() {
      stopped = true;
      clearInterval(handle);
      if (inFlight) await inFlight;
    },
  };
}

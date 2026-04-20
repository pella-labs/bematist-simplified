import { chooseK, clusterEmbeddings } from "@bematist/embed";
import type postgres from "postgres";

export interface ReclusterOptions {
  sql: postgres.Sql;
  minPromptsPerOrg?: number;
  seed?: number;
}

export interface ReclusterOrgResult {
  orgId: string;
  prompts: number;
  clusters: number;
  skipped?: string;
}

export interface ReclusterResult {
  orgs: ReclusterOrgResult[];
}

interface PromptRow {
  id: string;
  created_at: string;
  prompt_text: string;
  embedding: string;
}

const DIM = 384;
const LABEL_MAX = 80;

function parseVector(literal: string): Float32Array {
  // pgvector text format: "[0.1,0.2,...]"
  const body = literal.trim().replace(/^\[/, "").replace(/\]$/, "");
  const parts = body.split(",");
  const out = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    out[i] = Number(parts[i]);
  }
  return out;
}

function vectorLiteral(vec: Float32Array): string {
  const parts: string[] = [];
  for (let i = 0; i < vec.length; i++) {
    const n = vec[i] ?? 0;
    parts.push(n.toFixed(6));
  }
  return `[${parts.join(",")}]`;
}

function truncateLabel(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= LABEL_MAX) return oneLine;
  return `${oneLine.slice(0, LABEL_MAX - 1)}…`;
}

function squaredDistance(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    s += d * d;
  }
  return s;
}

async function listOrgs(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ org_id: string }[]>`
    SELECT DISTINCT org_id FROM prompts WHERE embedding IS NOT NULL
  `;
  return rows.map((r) => r.org_id);
}

async function loadEmbeddings(sql: postgres.Sql, orgId: string): Promise<PromptRow[]> {
  await sql`SELECT set_config('app.current_org_id', ${orgId}, true)`;
  const rows = await sql<PromptRow[]>`
    SELECT id, created_at::text AS created_at, prompt_text, embedding::text AS embedding
    FROM prompts
    WHERE org_id = ${orgId} AND embedding IS NOT NULL
  `;
  return rows;
}

async function reclusterOrg(
  sql: postgres.Sql,
  orgId: string,
  opts: Required<Pick<ReclusterOptions, "minPromptsPerOrg" | "seed">>,
): Promise<ReclusterOrgResult> {
  const rows = await loadEmbeddings(sql, orgId);
  if (rows.length < opts.minPromptsPerOrg) {
    return { orgId, prompts: rows.length, clusters: 0, skipped: "below minPromptsPerOrg" };
  }

  const vectors = rows.map((r) => parseVector(r.embedding));
  const k = chooseK(rows.length);
  const result = clusterEmbeddings(vectors, { k, seed: opts.seed });

  // Group row indices by cluster id.
  const members = new Array<number[]>(result.k);
  for (let i = 0; i < result.k; i++) members[i] = [];
  for (let i = 0; i < rows.length; i++) {
    const c = result.assignments[i] ?? 0;
    (members[c] as number[]).push(i);
  }

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;

    // Delete previous cluster rows for this org, set cluster_id to NULL on prompts.
    await tx`UPDATE prompts SET cluster_id = NULL WHERE org_id = ${orgId}`;
    await tx`DELETE FROM prompt_clusters WHERE org_id = ${orgId}`;

    for (let c = 0; c < result.k; c++) {
      const idxs = members[c] as number[];
      if (idxs.length === 0) continue;
      const centroid = result.centroids[c] as Float32Array;

      // Label = text of the prompt nearest the centroid, truncated.
      let nearestIdx = idxs[0] as number;
      let nearestDist = Infinity;
      for (const i of idxs) {
        const d = squaredDistance(vectors[i] as Float32Array, centroid);
        if (d < nearestDist) {
          nearestDist = d;
          nearestIdx = i;
        }
      }
      const label = truncateLabel((rows[nearestIdx] as PromptRow).prompt_text);
      const centroidLit = vectorLiteral(centroid);

      const inserted = await tx<{ id: string }[]>`
        INSERT INTO prompt_clusters (org_id, centroid, size, label)
        VALUES (${orgId}, ${centroidLit}::vector(384), ${idxs.length}, ${label})
        RETURNING id
      `;
      const clusterId = inserted[0]?.id;
      if (!clusterId) throw new Error("insert prompt_clusters returned no id");

      for (const i of idxs) {
        const row = rows[i] as PromptRow;
        await tx`
          UPDATE prompts
          SET cluster_id = ${clusterId}
          WHERE id = ${row.id} AND created_at::text = ${row.created_at}
        `;
      }
    }
  });

  const nonEmpty = members.filter((m) => m.length > 0).length;
  return { orgId, prompts: rows.length, clusters: nonEmpty };
}

export async function runReclusterOnce(options: ReclusterOptions): Promise<ReclusterResult> {
  const { sql, minPromptsPerOrg = 3, seed = 0x9e3779b9 } = options;
  const orgIds = await listOrgs(sql);
  const results: ReclusterOrgResult[] = [];
  for (const orgId of orgIds) {
    try {
      const r = await reclusterOrg(sql, orgId, { minPromptsPerOrg, seed });
      results.push(r);
    } catch (err) {
      console.error(`[worker/recluster] org ${orgId} failed:`, err);
      results.push({ orgId, prompts: 0, clusters: 0, skipped: String(err) });
    }
  }
  return { orgs: results };
}

export const __test__ = { parseVector, vectorLiteral, truncateLabel, DIM };

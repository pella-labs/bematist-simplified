import type { Usage } from "@bematist/contracts";
import type { Sql } from "postgres";

export interface ComputedCost {
  cost_usd: number;
  pricing_version: string;
}

export interface PricingRow {
  pricing_version: string;
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
  effective_from: Date;
  effective_to: Date | null;
}

const UNKNOWN: ComputedCost = { cost_usd: 0, pricing_version: "unknown" };
const warnedModels = new Set<string>();

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function normalizeRow(raw: Record<string, unknown>): PricingRow {
  return {
    pricing_version: String(raw.pricing_version ?? ""),
    model: String(raw.model ?? ""),
    input_per_mtok: toNumber(raw.input_per_mtok),
    output_per_mtok: toNumber(raw.output_per_mtok),
    cache_read_per_mtok: toNumber(raw.cache_read_per_mtok),
    cache_write_per_mtok: toNumber(raw.cache_write_per_mtok),
    effective_from:
      raw.effective_from instanceof Date
        ? raw.effective_from
        : new Date(String(raw.effective_from)),
    effective_to:
      raw.effective_to == null
        ? null
        : raw.effective_to instanceof Date
          ? raw.effective_to
          : new Date(String(raw.effective_to)),
  };
}

export function computeCostFromRow(row: PricingRow, usage: Usage): number {
  const tokens =
    usage.input_tokens * row.input_per_mtok +
    usage.output_tokens * row.output_per_mtok +
    usage.cache_read_tokens * row.cache_read_per_mtok +
    usage.cache_creation_tokens * row.cache_write_per_mtok;
  const usd = tokens / 1_000_000;
  return Math.round(usd * 1e10) / 1e10;
}

export async function lookupPricing(sql: Sql, model: string, at: Date): Promise<PricingRow | null> {
  try {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT pricing_version, model,
             input_per_mtok, output_per_mtok,
             cache_read_per_mtok, cache_write_per_mtok,
             effective_from, effective_to
      FROM pricing
      WHERE model = ${model}
        AND effective_from <= ${at}
        AND (effective_to IS NULL OR effective_to > ${at})
      ORDER BY effective_from DESC
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return normalizeRow(rows[0] as Record<string, unknown>);
  } catch {
    return null;
  }
}

export async function computeCost(
  sql: Sql,
  model: string | null,
  usage: Usage | null,
  at: Date,
): Promise<ComputedCost> {
  if (!model || !usage) return UNKNOWN;
  const row = await lookupPricing(sql, model, at);
  if (!row) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      console.warn(`[cost] unknown pricing for model="${model}"`);
    }
    return UNKNOWN;
  }
  return { cost_usd: computeCostFromRow(row, usage), pricing_version: row.pricing_version };
}

export const __test__ = { warnedModels };

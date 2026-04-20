import pricingV1 from "../../contracts/pricing/pricing-v1.json" with { type: "json" };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface ComputedCost {
  cost_usd: number;
  pricing_version: string;
}

export interface PricingRow {
  pricing_version: string;
  model: string;
  provider: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
  effective_from: Date;
  effective_to: Date | null;
}

export interface SubscriptionRow {
  provider: string;
  monthly_usd: number;
}

interface PricingFile {
  pricing_version: string;
  models: Array<{
    pricing_version: string;
    model: string;
    provider: string;
    input_per_mtok: string | null;
    output_per_mtok: string | null;
    cache_read_per_mtok: string | null;
    cache_write_per_mtok: string | null;
    effective_from: string;
    effective_to: string | null;
  }>;
  subscriptions: Record<string, SubscriptionRow>;
}

const PRICING: PricingFile = pricingV1 as PricingFile;

function toNumber(value: string | null): number {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const ROWS: PricingRow[] = PRICING.models.map((row) => ({
  pricing_version: row.pricing_version,
  model: row.model,
  provider: row.provider,
  input_per_mtok: toNumber(row.input_per_mtok),
  output_per_mtok: toNumber(row.output_per_mtok),
  cache_read_per_mtok: toNumber(row.cache_read_per_mtok),
  cache_write_per_mtok: toNumber(row.cache_write_per_mtok),
  effective_from: new Date(row.effective_from),
  effective_to: row.effective_to == null ? null : new Date(row.effective_to),
}));

const UNKNOWN: ComputedCost = { cost_usd: 0, pricing_version: "unknown" };
const warnedModels = new Set<string>();

export function listPricingRows(): readonly PricingRow[] {
  return ROWS;
}

export function listSubscriptions(): Readonly<Record<string, SubscriptionRow>> {
  return PRICING.subscriptions;
}

export function getSubscriptionMonthlyUsd(tier: string | null | undefined): number {
  if (!tier) return 0;
  const row = PRICING.subscriptions[tier];
  return row ? row.monthly_usd : 0;
}

export function findPricing(model: string, at: Date): PricingRow | null {
  const candidates = ROWS.filter(
    (r) =>
      r.model === model &&
      r.effective_from.getTime() <= at.getTime() &&
      (r.effective_to === null || r.effective_to.getTime() > at.getTime()),
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.effective_from.getTime() - a.effective_from.getTime());
  return candidates[0] ?? null;
}

export function computeCostFromRow(row: PricingRow, usage: Usage): number {
  const micro =
    usage.input_tokens * row.input_per_mtok +
    usage.output_tokens * row.output_per_mtok +
    usage.cache_read_tokens * row.cache_read_per_mtok +
    usage.cache_creation_tokens * row.cache_write_per_mtok;
  const usd = micro / 1_000_000;
  return Math.round(usd * 1e10) / 1e10;
}

export function computeCost(model: string | null, usage: Usage | null, at: Date): ComputedCost {
  if (!model || !usage) return UNKNOWN;
  const row = findPricing(model, at);
  if (!row) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      console.warn(`[embed/cost] unknown pricing for model="${model}"`);
    }
    return UNKNOWN;
  }
  return { cost_usd: computeCostFromRow(row, usage), pricing_version: row.pricing_version };
}

export const __test__ = { warnedModels };

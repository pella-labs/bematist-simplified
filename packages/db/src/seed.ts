import { readFile } from "node:fs/promises";

export interface PricingSeedRow {
  pricing_version: string;
  model: string;
  provider: string;
  input_per_mtok: string | null;
  output_per_mtok: string | null;
  cache_read_per_mtok: string | null;
  cache_write_per_mtok: string | null;
  effective_from: string;
  effective_to: string | null;
}

const PRICING_JSON_PATH = new URL("../seed/pricing.json", import.meta.url).pathname;

export async function loadPricingSeed(): Promise<PricingSeedRow[]> {
  const body = await readFile(PRICING_JSON_PATH, "utf8");
  const parsed = JSON.parse(body) as PricingSeedRow[];
  if (!Array.isArray(parsed)) {
    throw new Error("pricing.json must be an array");
  }
  return parsed;
}

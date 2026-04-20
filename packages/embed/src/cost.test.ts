import { describe, expect, test } from "bun:test";
import {
  computeCost,
  computeCostFromRow,
  findPricing,
  getSubscriptionMonthlyUsd,
  listPricingRows,
  listSubscriptions,
} from "./cost";

const AT = new Date("2026-04-15T00:00:00Z");

const ZERO = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
};

describe("computeCost", () => {
  test("claude-opus-4-7 matches hand-calculated cost with cache", () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 500_000,
      cache_read_tokens: 100_000,
      cache_creation_tokens: 20_000,
    };
    const result = computeCost("claude-opus-4-7", usage, AT);
    expect(result.pricing_version).toBe("v1");
    const expected = (1_000_000 * 15 + 500_000 * 75 + 100_000 * 1.5 + 20_000 * 18.75) / 1_000_000;
    expect(Math.abs(result.cost_usd - expected)).toBeLessThan(1e-8);
  });

  test("claude-sonnet-4-6 matches hand-calculated cost", () => {
    const usage = {
      input_tokens: 10_000,
      output_tokens: 2_000,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };
    const result = computeCost("claude-sonnet-4-6", usage, AT);
    const expected = (10_000 * 3 + 2_000 * 15) / 1_000_000;
    expect(Math.abs(result.cost_usd - expected)).toBeLessThan(1e-8);
  });

  test("claude-haiku-4-5 matches hand-calculated cost", () => {
    const usage = {
      input_tokens: 500_000,
      output_tokens: 50_000,
      cache_read_tokens: 10_000,
      cache_creation_tokens: 5_000,
    };
    const result = computeCost("claude-haiku-4-5", usage, AT);
    const expected = (500_000 * 1 + 50_000 * 5 + 10_000 * 0.1 + 5_000 * 1.25) / 1_000_000;
    expect(Math.abs(result.cost_usd - expected)).toBeLessThan(1e-8);
  });

  test("gpt-5 has no cache_write rate (treated as 0)", () => {
    const usage = {
      input_tokens: 100_000,
      output_tokens: 40_000,
      cache_read_tokens: 1000,
      cache_creation_tokens: 500,
    };
    const result = computeCost("gpt-5", usage, AT);
    const expected = (100_000 * 1.25 + 40_000 * 10 + 1000 * 0.125 + 500 * 0) / 1_000_000;
    expect(Math.abs(result.cost_usd - expected)).toBeLessThan(1e-8);
  });

  test("gpt-5-mini matches seeded rates", () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 1_000_000,
      cache_creation_tokens: 0,
    };
    const result = computeCost("gpt-5-mini", usage, AT);
    const expected = (1_000_000 * 0.25 + 1_000_000 * 2 + 1_000_000 * 0.025) / 1_000_000;
    expect(Math.abs(result.cost_usd - expected)).toBeLessThan(1e-8);
  });

  test("cursor-sonnet matches claude-sonnet rates", () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 1000,
      cache_read_tokens: 1000,
      cache_creation_tokens: 1000,
    };
    const cursor = computeCost("cursor-sonnet", usage, AT);
    const sonnet = computeCost("claude-sonnet-4-6", usage, AT);
    expect(cursor.cost_usd).toBe(sonnet.cost_usd);
  });

  test("unknown model returns zero with pricing_version='unknown'", () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 1000,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };
    const result = computeCost("claude-sonnet-7-0-not-real", usage, AT);
    expect(result).toEqual({ cost_usd: 0, pricing_version: "unknown" });
  });

  test("null model or usage returns unknown without throwing", () => {
    expect(computeCost(null, ZERO, AT)).toEqual({ cost_usd: 0, pricing_version: "unknown" });
    expect(computeCost("claude-sonnet-4-6", null, AT)).toEqual({
      cost_usd: 0,
      pricing_version: "unknown",
    });
  });

  test("all-zeros usage yields zero cost with real pricing_version", () => {
    const result = computeCost("claude-opus-4-7", ZERO, AT);
    expect(result.cost_usd).toBe(0);
    expect(result.pricing_version).toBe("v1");
  });

  test("cache-only usage computes cache-only cost", () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 1_000_000,
      cache_creation_tokens: 1_000_000,
    };
    const result = computeCost("claude-opus-4-7", usage, AT);
    expect(result.cost_usd).toBeCloseTo(1.5 + 18.75, 8);
  });

  test("before effective_from returns unknown", () => {
    const usage = { ...ZERO, input_tokens: 1_000_000 };
    const before = new Date("2025-06-01T00:00:00Z");
    const result = computeCost("claude-opus-4-7", usage, before);
    expect(result.pricing_version).toBe("unknown");
    expect(result.cost_usd).toBe(0);
  });
});

describe("findPricing / listings", () => {
  test("findPricing returns the matching row at a valid date", () => {
    const row = findPricing("claude-opus-4-7", AT);
    expect(row).not.toBeNull();
    expect(row?.model).toBe("claude-opus-4-7");
    expect(row?.input_per_mtok).toBe(15);
  });

  test("listPricingRows contains all six canonical models", () => {
    const rows = listPricingRows();
    const models = rows.map((r) => r.model).sort();
    expect(models).toEqual(
      [
        "claude-haiku-4-5",
        "claude-opus-4-7",
        "claude-sonnet-4-6",
        "cursor-sonnet",
        "gpt-5",
        "gpt-5-mini",
      ].sort(),
    );
  });

  test("subscriptions cover every tier the detector can emit", () => {
    const subs = listSubscriptions();
    expect(subs.max_200?.monthly_usd).toBe(200);
    expect(subs.pro_20?.monthly_usd).toBe(20);
    expect(subs.business?.monthly_usd).toBe(150);
    expect(subs.plus?.monthly_usd).toBe(20);
    expect(subs.pro?.monthly_usd).toBe(200);
    expect(subs.team?.monthly_usd).toBe(200);
    expect(subs.api_key?.monthly_usd).toBe(0);
  });

  test("getSubscriptionMonthlyUsd is 0 for unknown/null tiers", () => {
    expect(getSubscriptionMonthlyUsd(null)).toBe(0);
    expect(getSubscriptionMonthlyUsd(undefined)).toBe(0);
    expect(getSubscriptionMonthlyUsd("not-a-tier")).toBe(0);
  });

  test("computeCostFromRow is deterministic", () => {
    const row = findPricing("claude-sonnet-4-6", AT)!;
    const a = computeCostFromRow(row, {
      input_tokens: 123,
      output_tokens: 456,
      cache_read_tokens: 7,
      cache_creation_tokens: 8,
    });
    const b = computeCostFromRow(row, {
      input_tokens: 123,
      output_tokens: 456,
      cache_read_tokens: 7,
      cache_creation_tokens: 8,
    });
    expect(a).toBe(b);
  });
});

describe("canonical pricing JSON matches db/seed/pricing.json", () => {
  test("every seeded row has a canonical row with identical numerics", async () => {
    const seedPath = new URL("../../../packages/db/seed/pricing.json", import.meta.url).pathname;
    const body = await Bun.file(seedPath).text();
    const seeded = JSON.parse(body) as Array<{
      pricing_version: string;
      model: string;
      input_per_mtok: string | null;
      output_per_mtok: string | null;
      cache_read_per_mtok: string | null;
      cache_write_per_mtok: string | null;
    }>;
    const canonical = listPricingRows();
    for (const row of seeded) {
      const match = canonical.find(
        (r) => r.model === row.model && r.pricing_version === row.pricing_version,
      );
      expect(match).toBeDefined();
      expect(match?.input_per_mtok).toBe(Number(row.input_per_mtok ?? 0));
      expect(match?.output_per_mtok).toBe(Number(row.output_per_mtok ?? 0));
      expect(match?.cache_read_per_mtok).toBe(Number(row.cache_read_per_mtok ?? 0));
      expect(match?.cache_write_per_mtok).toBe(Number(row.cache_write_per_mtok ?? 0));
    }
  });
});

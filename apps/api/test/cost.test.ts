import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Sql } from "postgres";
import { computeCost } from "../src/pipeline/cost";
import { createTestSchema, seedPricing, type TestSchema } from "./fixtures/db";

let db: TestSchema;
let sql: Sql;
const at = new Date("2026-04-19T12:00:00Z");

beforeAll(async () => {
  db = await createTestSchema();
  sql = db.sql;
  await seedPricing(sql);
});

afterAll(async () => {
  await db.close();
});

const within = (actual: number, expected: number, tolerance = 0.0001) => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
};

describe("computeCost", () => {
  it("prices Claude Sonnet 4.6 correctly", async () => {
    const result = await computeCost(
      sql,
      "claude-sonnet-4-6",
      {
        input_tokens: 1_000_000,
        output_tokens: 500_000,
        cache_read_tokens: 200_000,
        cache_creation_tokens: 100_000,
      },
      at,
    );
    within(result.cost_usd, 3.0 + 7.5 + 0.06 + 0.375);
    expect(result.pricing_version).toBe("test-v1");
  });

  it("prices Claude Opus 4.7 correctly", async () => {
    const result = await computeCost(
      sql,
      "claude-opus-4-7",
      {
        input_tokens: 50_000,
        output_tokens: 10_000,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      at,
    );
    within(result.cost_usd, (50_000 * 15 + 10_000 * 75) / 1_000_000);
    expect(result.pricing_version).toBe("test-v1");
  });

  it("prices gpt-5 correctly", async () => {
    const result = await computeCost(
      sql,
      "gpt-5",
      {
        input_tokens: 250_000,
        output_tokens: 50_000,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      at,
    );
    within(result.cost_usd, (250_000 * 5 + 50_000 * 15) / 1_000_000);
  });

  it("prices cursor-sonnet correctly", async () => {
    const result = await computeCost(
      sql,
      "cursor-sonnet",
      {
        input_tokens: 120_000,
        output_tokens: 40_000,
        cache_read_tokens: 80_000,
        cache_creation_tokens: 20_000,
      },
      at,
    );
    within(result.cost_usd, (120_000 * 3 + 40_000 * 15 + 80_000 * 0.3 + 20_000 * 3.75) / 1_000_000);
  });

  it("returns pricing_version 'unknown' for an unmapped model", async () => {
    const result = await computeCost(
      sql,
      "mystery-model-42",
      {
        input_tokens: 100,
        output_tokens: 100,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      at,
    );
    expect(result).toEqual({ cost_usd: 0, pricing_version: "unknown" });
  });

  it("never throws when usage is null", async () => {
    const result = await computeCost(sql, "claude-sonnet-4-6", null, at);
    expect(result).toEqual({ cost_usd: 0, pricing_version: "unknown" });
  });

  it("never throws when model is null", async () => {
    const result = await computeCost(
      sql,
      null,
      {
        input_tokens: 1000,
        output_tokens: 1000,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      at,
    );
    expect(result).toEqual({ cost_usd: 0, pricing_version: "unknown" });
  });
});

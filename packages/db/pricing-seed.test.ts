import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { createMigratedDatabase, type TempDatabase } from "./testing";

let tmp: TempDatabase;
let sql: postgres.Sql;

const EXPECTED_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-haiku-4-5",
  "gpt-5",
  "gpt-5-mini",
  "cursor-sonnet",
];

beforeAll(async () => {
  tmp = await createMigratedDatabase();
  sql = postgres(tmp.url, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  if (tmp) await tmp.drop();
});

test("every expected model is seeded", async () => {
  const rows = await sql<{ model: string; pricing_version: string }[]>`
    SELECT model, pricing_version FROM pricing ORDER BY model
  `;
  const models = rows.map((r) => r.model).sort();
  expect(models).toEqual([...EXPECTED_MODELS].sort());
  for (const row of rows) expect(row.pricing_version).toBe("v1");
});

test("claude-opus-4-7 has the documented input and output rates", async () => {
  const [row] = await sql<{ input: string; output: string }[]>`
    SELECT input_per_mtok AS input, output_per_mtok AS output
    FROM pricing WHERE model = 'claude-opus-4-7'
  `;
  expect(row).toBeDefined();
  expect(Number(row!.input)).toBe(15);
  expect(Number(row!.output)).toBe(75);
});

test("claude cache rates are present, openai cache_write is null", async () => {
  const claudeRows = await sql<{ cache_read: string; cache_write: string }[]>`
    SELECT cache_read_per_mtok AS cache_read, cache_write_per_mtok AS cache_write
    FROM pricing WHERE provider = 'anthropic'
  `;
  for (const r of claudeRows) {
    expect(r.cache_read).not.toBeNull();
    expect(r.cache_write).not.toBeNull();
  }

  const openaiRows = await sql<{ cache_write: string | null }[]>`
    SELECT cache_write_per_mtok AS cache_write
    FROM pricing WHERE provider = 'openai'
  `;
  for (const r of openaiRows) expect(r.cache_write).toBeNull();
});

test("re-running pricing seed does not duplicate rows", async () => {
  const before = await sql<{ count: string }[]>`SELECT count(*) FROM pricing`;
  const { runMigrations } = await import("./src/migrate");
  await runMigrations({ url: tmp.url });
  const after = await sql<{ count: string }[]>`SELECT count(*) FROM pricing`;
  expect(after[0]!.count).toBe(before[0]!.count);
});

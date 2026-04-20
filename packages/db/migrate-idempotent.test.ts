import { afterAll, beforeAll, expect, test } from "bun:test";
import { runMigrations } from "./src/migrate";
import { createTempDatabase, type TempDatabase } from "./testing";

let tmp: TempDatabase;

beforeAll(async () => {
  tmp = await createTempDatabase();
});

afterAll(async () => {
  if (tmp) await tmp.drop();
});

test("first runMigrations applies every file", async () => {
  const result = await runMigrations({ url: tmp.url });
  expect(result.applied.length).toBeGreaterThan(0);
  expect(result.skipped.length).toBe(0);
});

test("second runMigrations is a no-op", async () => {
  const result = await runMigrations({ url: tmp.url });
  expect(result.applied.length).toBe(0);
  expect(result.skipped.length).toBeGreaterThan(0);
});

test("third runMigrations is still a no-op", async () => {
  const result = await runMigrations({ url: tmp.url });
  expect(result.applied.length).toBe(0);
  expect(result.skipped.length).toBeGreaterThan(0);
});

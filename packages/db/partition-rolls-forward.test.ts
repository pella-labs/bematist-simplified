import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { createMigratedDatabase, type TempDatabase } from "./testing";

let tmp: TempDatabase;
let admin: postgres.Sql;

beforeAll(async () => {
  tmp = await createMigratedDatabase();
  admin = postgres(tmp.url, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  if (admin) await admin.end({ timeout: 5 });
  if (tmp) await tmp.drop();
});

async function monthlyPartitions(parent: "events" | "prompts"): Promise<string[]> {
  const rows = await admin<{ child: string }[]>`
    SELECT c.relname AS child
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = ${parent}
    ORDER BY c.relname
  `;
  return rows.map((r) => r.child);
}

test("initial migrate seeds current month plus three forward", async () => {
  const events = await monthlyPartitions("events");
  const prompts = await monthlyPartitions("prompts");
  expect(events.length).toBeGreaterThanOrEqual(4);
  expect(prompts.length).toBeGreaterThanOrEqual(4);
  expect(events.length).toBe(prompts.length);
});

test("calling ensure_partitions a second time is idempotent", async () => {
  const before = await monthlyPartitions("events");
  await admin`SELECT ensure_partitions(3)`;
  const after = await monthlyPartitions("events");
  expect(after.length).toBe(before.length);
  expect(after).toEqual(before);
});

test("ensure_partitions(6) extends forward without duplicating", async () => {
  const before = await monthlyPartitions("events");
  await admin`SELECT ensure_partitions(6)`;
  const after = await monthlyPartitions("events");
  expect(after.length).toBeGreaterThan(before.length);
  expect(new Set(after).size).toBe(after.length);
  for (const p of before) expect(after).toContain(p);
});

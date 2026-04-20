import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getAdminDb, getDb, type OrgScopedDb } from "@bematist/db";
import { createMigratedDatabase, type TempDatabase } from "@bematist/db/testing";
import { computeMonthlyDelta } from "./delta";

let tmp: TempDatabase;
let orgId: string;
let devId: string;
let devNoSubId: string;
let emptyDevId: string;
let db: OrgScopedDb;

beforeAll(async () => {
  tmp = await createMigratedDatabase();
  const admin = getAdminDb({ url: tmp.url });
  try {
    orgId = randomUUID();
    devId = randomUUID();
    devNoSubId = randomUUID();
    emptyDevId = randomUUID();
    const sessionId = randomUUID();
    await admin.db.execute(
      `INSERT INTO orgs (id, slug, name) VALUES ('${orgId}', 'delta-test', 'delta-test')` as never,
    );
    await admin.db.execute(
      `INSERT INTO developers (id, org_id, email, name, subscription_claude, subscription_codex, subscription_cursor) VALUES ('${devId}', '${orgId}', 'a@b.c', 'Alice', 'max_200', 'plus', null)` as never,
    );
    await admin.db.execute(
      `INSERT INTO developers (id, org_id, email, name) VALUES ('${devNoSubId}', '${orgId}', 'c@d.e', 'Bob')` as never,
    );
    await admin.db.execute(
      `INSERT INTO developers (id, org_id, email, name, subscription_claude) VALUES ('${emptyDevId}', '${orgId}', 'e@f.g', 'Empty', 'pro_20')` as never,
    );
    await admin.db.execute(
      `INSERT INTO sessions (id, org_id, developer_id, source, source_session_id, started_at) VALUES ('${sessionId}', '${orgId}', '${devId}', 'claude-code', 'ssn-1', '2026-04-05T00:00:00Z')` as never,
    );
    const inMonth = [
      { seq: 1, ts: "2026-04-01T00:00:00Z", cost: "10.00" },
      { seq: 2, ts: "2026-04-12T12:00:00Z", cost: "25.50" },
      { seq: 3, ts: "2026-04-30T23:00:00Z", cost: "4.50" },
    ];
    for (const row of inMonth) {
      await admin.db.execute(
        `INSERT INTO events (id, org_id, developer_id, session_id, event_seq, ts, kind, cost_usd, client_event_id) VALUES ('${randomUUID()}', '${orgId}', '${devId}', '${sessionId}', ${row.seq}, '${row.ts}', 'user_prompt', ${row.cost}, '${randomUUID()}')` as never,
      );
    }
    const outOfMonth = [{ seq: 11, ts: "2026-05-01T00:00:00Z", cost: "200.00" }];
    for (const row of outOfMonth) {
      await admin.db.execute(
        `INSERT INTO events (id, org_id, developer_id, session_id, event_seq, ts, kind, cost_usd, client_event_id) VALUES ('${randomUUID()}', '${orgId}', '${devId}', '${sessionId}', ${row.seq}, '${row.ts}', 'user_prompt', ${row.cost}, '${randomUUID()}')` as never,
      );
    }
    await admin.db.execute(
      `INSERT INTO events (id, org_id, developer_id, session_id, event_seq, ts, kind, cost_usd, client_event_id) VALUES ('${randomUUID()}', '${orgId}', '${devNoSubId}', '${sessionId}', 20, '2026-04-10T00:00:00Z', 'user_prompt', 7.75, '${randomUUID()}')` as never,
    );
  } finally {
    await admin.close();
  }
  db = getDb(orgId, { url: tmp.url });
});

afterAll(async () => {
  if (db) await db.close();
  if (tmp) await tmp.drop();
});

test("aggregates in-month events, ignores neighboring months", async () => {
  const result = await computeMonthlyDelta(db, devId, new Date("2026-04-15T00:00:00Z"));
  expect(result.actualUsd).toBeCloseTo(40, 6);
  expect(result.subscriptionUsd).toBe(220);
  expect(result.deltaUsd).toBeCloseTo(-180, 6);
});

test("developer with no subscription fields treats subscriptionUsd as 0", async () => {
  const result = await computeMonthlyDelta(db, devNoSubId, new Date("2026-04-01T00:00:00Z"));
  expect(result.actualUsd).toBeCloseTo(7.75, 6);
  expect(result.subscriptionUsd).toBe(0);
  expect(result.deltaUsd).toBeCloseTo(7.75, 6);
});

test("developer with subscription but no events yields negative delta = -sub", async () => {
  const result = await computeMonthlyDelta(db, emptyDevId, new Date("2026-04-01T00:00:00Z"));
  expect(result.actualUsd).toBe(0);
  expect(result.subscriptionUsd).toBe(20);
  expect(result.deltaUsd).toBe(-20);
});

test("unknown developer id returns all zeros without throwing", async () => {
  const result = await computeMonthlyDelta(db, randomUUID(), new Date("2026-04-01T00:00:00Z"));
  expect(result).toEqual({ actualUsd: 0, subscriptionUsd: 0, deltaUsd: 0 });
});

test("querying a month with no events returns zero actual but keeps subscription", async () => {
  const result = await computeMonthlyDelta(db, devId, new Date("2026-06-15T00:00:00Z"));
  expect(result.actualUsd).toBe(0);
  expect(result.subscriptionUsd).toBe(220);
  expect(result.deltaUsd).toBe(-220);
});

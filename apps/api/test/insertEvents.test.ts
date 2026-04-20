import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Sql } from "postgres";
import { insertEvents } from "../src/pipeline/insertEvents";
import { createTestSchema, seedIngestKey, type TestSchema } from "./fixtures/db";
import { makeAssistantEnvelope, makeEnvelope } from "./fixtures/envelopes";

let db: TestSchema;
let sql: Sql;

beforeAll(async () => {
  db = await createTestSchema();
  sql = db.sql;
});

afterAll(async () => {
  await db.close();
});

describe("insertEvents", () => {
  it("inserts a batch and reports accepted count", async () => {
    const seeded = await seedIngestKey(sql);
    const events = [
      makeEnvelope({ source_session_id: "s1", event_seq: 0 }),
      makeEnvelope({ source_session_id: "s1", event_seq: 1 }),
      makeEnvelope({ source_session_id: "s1", event_seq: 2 }),
    ];
    const result = await insertEvents(sql, seeded.orgId, seeded.developerId, events);
    expect(result).toEqual({ accepted: 3, deduped: 0 });
  });

  it("dedups on (org_id, session_id, event_seq, client_event_id)", async () => {
    const seeded = await seedIngestKey(sql);
    const event = makeEnvelope({ source_session_id: "dedup-session", event_seq: 7 });
    const first = await insertEvents(sql, seeded.orgId, seeded.developerId, [event]);
    expect(first).toEqual({ accepted: 1, deduped: 0 });
    const second = await insertEvents(sql, seeded.orgId, seeded.developerId, [event]);
    expect(second).toEqual({ accepted: 0, deduped: 1 });
  });

  it("inserts two events with different event_seq values", async () => {
    const seeded = await seedIngestKey(sql);
    const sameSession = "multi-seq";
    const a = makeEnvelope({ source_session_id: sameSession, event_seq: 0 });
    const b = makeEnvelope({ source_session_id: sameSession, event_seq: 1 });
    const result = await insertEvents(sql, seeded.orgId, seeded.developerId, [a, b]);
    expect(result).toEqual({ accepted: 2, deduped: 0 });
  });

  it("computes cost_usd inline from pricing table", async () => {
    const seeded = await seedIngestKey(sql);
    const ev = makeAssistantEnvelope(
      "claude-sonnet-4-6",
      { input: 1_000_000, output: 500_000, cacheRead: 0, cacheCreate: 0 },
      { source_session_id: "cost-s", event_seq: 0 },
    );
    await insertEvents(sql, seeded.orgId, seeded.developerId, [ev]);
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${seeded.orgId}, true)`;
      return tx<{ cost_usd: string }[]>`
        SELECT e.cost_usd::text
        FROM events e
        JOIN sessions s ON s.id = e.session_id
        WHERE s.source_session_id = 'cost-s' AND e.event_seq = 0 AND e.org_id = ${seeded.orgId}
      `;
    });
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(Number(row.cost_usd)).toBeCloseTo(3.0 + 7.5, 6);
  });

  it("persists developer_id from the auth seam, ignoring envelope inputs", async () => {
    const seeded = await seedIngestKey(sql);
    const event = makeEnvelope({ source_session_id: "owner-check", event_seq: 0 });
    await insertEvents(sql, seeded.orgId, seeded.developerId, [event]);
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${seeded.orgId}, true)`;
      return tx<{ developer_id: string; org_id: string }[]>`
        SELECT e.developer_id, e.org_id
        FROM events e
        JOIN sessions s ON s.id = e.session_id
        WHERE s.source_session_id = 'owner-check' AND e.org_id = ${seeded.orgId}
      `;
    });
    expect(rows[0]?.developer_id).toBe(seeded.developerId);
    expect(rows[0]?.org_id).toBe(seeded.orgId);
  });

  it("enforces RLS: cross-org reads return 0 rows", async () => {
    const orgA = await seedIngestKey(sql);
    const orgB = await seedIngestKey(sql);

    const eventA = makeEnvelope({ source_session_id: "rls-a", event_seq: 0 });
    await insertEvents(sql, orgA.orgId, orgA.developerId, [eventA]);

    const visibleToB = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgB.orgId}, true)`;
      return tx<{ n: string }[]>`
        SELECT count(*)::text AS n
        FROM events e
        JOIN sessions s ON s.id = e.session_id
        WHERE s.source_session_id = 'rls-a'
      `;
    });
    expect(Number(visibleToB[0]?.n ?? -1)).toBe(0);

    const visibleToA = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgA.orgId}, true)`;
      return tx<{ n: string }[]>`
        SELECT count(*)::text AS n
        FROM events e
        JOIN sessions s ON s.id = e.session_id
        WHERE s.source_session_id = 'rls-a'
      `;
    });
    expect(Number(visibleToA[0]?.n ?? -1)).toBe(1);
  });
});

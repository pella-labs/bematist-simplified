import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { insertEvents } from "../src/pipeline/insertEvents";
import { createTestSchema, seedIngestKey, seedPricing, type TestSchema } from "./fixtures/db";
import { makeEnvelope } from "./fixtures/envelopes";

let db: TestSchema;
let sql: Sql;

beforeAll(async () => {
  db = await createTestSchema();
  sql = db.sql;
  await seedPricing(sql);
});

afterAll(async () => {
  await db.close();
});

describe("perf", () => {
  it("inserts 10k events across 10 batches in under 2500ms", async () => {
    const seeded = await seedIngestKey(sql);
    const batches: ReturnType<typeof makeEnvelope>[][] = [];
    for (let b = 0; b < 10; b++) {
      const rows = [];
      for (let i = 0; i < 1_000; i++) {
        rows.push(
          makeEnvelope({
            client_event_id: randomUUID(),
            session_id: `perf-${b}`,
            event_seq: i,
          }),
        );
      }
      batches.push(rows);
    }

    const start = performance.now();
    let totalAccepted = 0;
    for (const batch of batches) {
      const r = await insertEvents(sql, seeded.orgId, seeded.developerId, batch);
      totalAccepted += r.accepted;
    }
    const elapsed = performance.now() - start;

    expect(totalAccepted).toBe(10_000);
    // Soft guard — fail only if badly slow. Adjust if flaky on CI.
    expect(elapsed).toBeLessThan(2500);
    console.log(`[perf] 10k events in ${elapsed.toFixed(1)}ms`);
  });
});

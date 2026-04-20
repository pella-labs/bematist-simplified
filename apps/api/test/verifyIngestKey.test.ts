import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { verifyIngestKey } from "../src/auth/verifyIngestKey";
import { UnauthorizedError } from "../src/errors";
import { createTestSchema, seedIngestKey, type TestSchema } from "./fixtures/db";

let db: TestSchema;
let sql: Sql;

beforeAll(async () => {
  db = await createTestSchema();
  sql = db.sql;
});

afterAll(async () => {
  await db.close();
});

describe("verifyIngestKey", () => {
  it("returns orgId + developerId for a valid key", async () => {
    const key = await seedIngestKey(sql);
    const verified = await verifyIngestKey(sql, `Bearer ${key.bearer}`);
    expect(verified.orgId).toBe(key.orgId);
    expect(verified.developerId).toBe(key.developerId);
    expect(verified.keyId).toBe(key.keyId);
  });

  it("rejects a malformed bearer header", async () => {
    await expect(verifyIngestKey(sql, "Bearer not-a-real-token")).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(verifyIngestKey(sql, null)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(verifyIngestKey(sql, "Basic abc")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a non-uuid orgId", async () => {
    const bearer = `bm_not-a-uuid_${"a".repeat(16)}_${"b".repeat(32)}`;
    await expect(verifyIngestKey(sql, `Bearer ${bearer}`)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("returns 401 when the key is not found", async () => {
    const orgId = randomUUID();
    const keyId = randomBytes(8).toString("hex");
    const secret = randomBytes(32).toString("hex");
    const bearer = `bm_${orgId}_${keyId}_${secret}`;
    await expect(verifyIngestKey(sql, `Bearer ${bearer}`)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("returns 401 when the secret hash does not match", async () => {
    const seeded = await seedIngestKey(sql);
    const forged = `bm_${seeded.orgId}_${seeded.keyId}_${"x".repeat(64)}`;
    await expect(verifyIngestKey(sql, `Bearer ${forged}`)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("returns 401 when the key has been revoked", async () => {
    const seeded = await seedIngestKey(sql, { revoked: true });
    await expect(verifyIngestKey(sql, `Bearer ${seeded.bearer}`)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("does timing-safe comparison even for missing keys", async () => {
    const orgId = randomUUID();
    const keyId = randomBytes(8).toString("hex");
    const secret = randomBytes(32).toString("hex");
    const bearer = `bm_${orgId}_${keyId}_${secret}`;
    const missStart = performance.now();
    await verifyIngestKey(sql, `Bearer ${bearer}`).catch(() => {});
    const missElapsed = performance.now() - missStart;

    const seeded = await seedIngestKey(sql);
    const wrongSecret = `bm_${seeded.orgId}_${seeded.keyId}_${"z".repeat(64)}`;
    const wrongStart = performance.now();
    await verifyIngestKey(sql, `Bearer ${wrongSecret}`).catch(() => {});
    const wrongElapsed = performance.now() - wrongStart;

    expect(Number.isFinite(missElapsed)).toBe(true);
    expect(Number.isFinite(wrongElapsed)).toBe(true);
  });

  it("rejects keys whose secret hashes to a different value than stored", async () => {
    const orgId = randomUUID();
    const developerId = randomUUID();
    const keyId = randomBytes(8).toString("hex");
    const storedSha = createHash("sha256").update("one secret").digest("hex");
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx`
        INSERT INTO orgs (id, slug, name)
        VALUES (${orgId}, ${`org-${keyId}`}, ${`org-${keyId}`})
      `;
      await tx`
        INSERT INTO developers (id, org_id, email, name)
        VALUES (${developerId}, ${orgId}, ${`dev-${keyId}@test`}, ${`dev-${keyId}`})
      `;
      await tx`
        INSERT INTO ingest_keys (id, org_id, developer_id, key_sha256)
        VALUES (${`bm_${orgId}_${keyId}`}, ${orgId}, ${developerId}, ${storedSha})
      `;
    });
    const bearer = `bm_${orgId}_${keyId}_${"another-secret-that-is-long-enough"}`;
    await expect(verifyIngestKey(sql, `Bearer ${bearer}`)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});

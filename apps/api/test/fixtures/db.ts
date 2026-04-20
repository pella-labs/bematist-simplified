import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createMigratedDatabase, type TempDatabase } from "@bematist/db/testing";
import postgres, { type Sql } from "postgres";

const APP_ROLE = "app_bematist";
const APP_PASSWORD = "app_bematist_dev";

export interface TestSchema {
  sql: Sql;
  dbName: string;
  close: () => Promise<void>;
}

function withAppRole(adminUrl: string): string {
  const u = new URL(adminUrl);
  u.username = APP_ROLE;
  u.password = APP_PASSWORD;
  return u.toString();
}

export async function createTestSchema(): Promise<TestSchema> {
  const temp: TempDatabase = await createMigratedDatabase();
  const sql = postgres(withAppRole(temp.url), { max: 4, prepare: false });
  return {
    sql,
    dbName: temp.name,
    async close() {
      await sql.end({ timeout: 1 });
      await temp.drop();
    },
  };
}

export interface SeededKey {
  orgId: string;
  developerId: string;
  keyId: string;
  bearer: string;
}

export async function seedIngestKey(
  sql: Sql,
  opts: { revoked?: boolean } = {},
): Promise<SeededKey> {
  const orgId = randomUUID();
  const developerId = randomUUID();
  const keyId = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const bearer = `bm_${orgId}_${keyId}_${secret}`;
  const id = `bm_${orgId}_${keyId}`;
  const sha = createHash("sha256").update(secret).digest("hex");
  const revokedAt = opts.revoked ? new Date() : null;

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    await tx`
      INSERT INTO orgs (id, slug, name)
      VALUES (${orgId}, ${`org-${keyId}`}, ${`org-${keyId}`})
      ON CONFLICT DO NOTHING
    `;
    await tx`
      INSERT INTO developers (id, org_id, email, name)
      VALUES (${developerId}, ${orgId}, ${`dev-${keyId}@test`}, ${`dev-${keyId}`})
      ON CONFLICT DO NOTHING
    `;
    await tx`
      INSERT INTO ingest_keys (id, org_id, developer_id, key_sha256, revoked_at)
      VALUES (${id}, ${orgId}, ${developerId}, ${sha}, ${revokedAt})
    `;
  });

  return { orgId, developerId, keyId, bearer };
}

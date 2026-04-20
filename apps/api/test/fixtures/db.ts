import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import postgres from "postgres";
import pricingFixture from "./pricing.json" with { type: "json" };

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(resolve(here, "inline-schema.sql"), "utf8");

const DEFAULT_URL = "postgres://bematist:bematist@localhost:5432/bematist";

export interface TestSchema {
  sql: Sql;
  schema: string;
  close: () => Promise<void>;
}

function schemaName(): string {
  return `ws2_test_${randomBytes(6).toString("hex")}`;
}

const APP_ROLE = "bematist_app";

async function ensureAppRole(databaseUrl: string) {
  const admin = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const exists = await admin<
      { exists: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}) AS exists`;
    if (!exists[0]?.exists) {
      await admin.unsafe(`CREATE ROLE ${APP_ROLE} NOINHERIT LOGIN PASSWORD '${APP_ROLE}'`);
    }
  } finally {
    await admin.end({ timeout: 1 });
  }
}

export async function createTestSchema(databaseUrl = process.env.DATABASE_URL ?? DEFAULT_URL) {
  await ensureAppRole(databaseUrl);
  const schema = schemaName();
  const admin = postgres(databaseUrl, { max: 1, prepare: false });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  // Apply schema DDL as superuser so we own the DDL (and can drop on teardown)...
  const adminSql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connection: { search_path: `"${schema}",public` },
  });
  await adminSql.unsafe(SCHEMA_SQL);
  // ...then hand ownership of tables + schema-level usage to the app role so
  // RLS actually applies on read/write paths.
  await adminSql.unsafe(`
    ALTER TABLE "${schema}".events OWNER TO ${APP_ROLE};
    ALTER TABLE "${schema}".ingest_keys OWNER TO ${APP_ROLE};
    ALTER TABLE "${schema}".pricing OWNER TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA "${schema}" TO ${APP_ROLE};
    GRANT ALL ON ALL TABLES IN SCHEMA "${schema}" TO ${APP_ROLE};
    GRANT ALL ON ALL SEQUENCES IN SCHEMA "${schema}" TO ${APP_ROLE};
  `);
  await adminSql.end({ timeout: 1 });
  await admin.end({ timeout: 1 });

  const appUrl = new URL(databaseUrl);
  appUrl.username = APP_ROLE;
  appUrl.password = APP_ROLE;

  const sql = postgres(appUrl.toString(), {
    max: 4,
    prepare: false,
    connection: { search_path: `"${schema}",public` },
  });

  const close = async () => {
    await sql.end({ timeout: 1 });
    const cleanup = postgres(databaseUrl, { max: 1, prepare: false });
    await cleanup.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end({ timeout: 1 });
  };

  return { sql, schema, close } satisfies TestSchema;
}

export async function seedPricing(sql: Sql, effectiveFrom = "2026-01-01T00:00:00Z") {
  for (const row of pricingFixture.rows) {
    await sql`
      INSERT INTO pricing (pricing_version, model, provider,
                           input_per_mtok, output_per_mtok,
                           cache_read_per_mtok, cache_write_per_mtok,
                           effective_from)
      VALUES (${pricingFixture.pricing_version}, ${row.model}, ${row.provider},
              ${row.input_per_mtok}, ${row.output_per_mtok},
              ${row.cache_read_per_mtok}, ${row.cache_write_per_mtok},
              ${effectiveFrom})
    `;
  }
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
  await sql`
    INSERT INTO ingest_keys (id, org_id, developer_id, key_sha256, revoked_at)
    VALUES (${id}, ${orgId}, ${developerId}, ${sha}, ${revokedAt})
  `;
  return { orgId, developerId, keyId, bearer };
}

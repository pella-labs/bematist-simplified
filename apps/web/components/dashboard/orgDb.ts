import type { DrizzleDb, OrgScopedDb, TxRunner } from "@bematist/db";
import { sql as sqlTag } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * Per-call tenant-scoped transaction. Mirrors the helper in apps/web/lib/session.ts.
 * Duplicated here so this module (and the query helpers + tests that depend on it)
 * can be imported without pulling in Next's `server-only` marker — same workaround
 * WS-4 used to avoid Turbopack's static-import-graph restriction on packages/db.
 */
export async function withOrgScope<T>(
  orgId: string,
  fn: (db: DrizzleDb) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-fA-F-]{36}$/.test(orgId)) throw new Error(`invalid orgId: ${orgId}`);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: 2, prepare: false });
  const db = drizzle(client);
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sqlTag`SELECT set_config('app.current_org_id', ${orgId}, true)`);
      return fn(tx as unknown as DrizzleDb);
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * Bridge between the inline withOrgScope (per-call connection) and
 * `@bematist/embed`'s OrgScopedDb interface. withOrgScope manages its own
 * connection lifecycle per call, so close() here is a no-op.
 */
export function orgScopedDb(orgId: string): OrgScopedDb {
  return {
    async withOrg<T>(fn: TxRunner<T>): Promise<T> {
      return withOrgScope(orgId, async (tx) => fn(tx));
    },
    async close() {},
  };
}

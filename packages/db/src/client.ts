import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../schema";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;
export type TxRunner<T> = (tx: DrizzleDb) => Promise<T>;

export interface OrgScopedDb {
  withOrg<T>(fn: TxRunner<T>): Promise<T>;
  close(): Promise<void>;
}

export interface ClientOptions {
  url?: string;
  max?: number;
}

function resolveUrl(url: string | undefined): string {
  const resolved = url ?? process.env.DATABASE_URL;
  if (!resolved) {
    throw new Error("DATABASE_URL is not set");
  }
  return resolved;
}

export function getDb(orgId: string, options: ClientOptions = {}): OrgScopedDb {
  if (!/^[0-9a-fA-F-]{36}$/.test(orgId)) {
    throw new Error(`invalid orgId: ${orgId}`);
  }
  const client = postgres(resolveUrl(options.url), {
    max: options.max ?? 5,
    prepare: false,
  });
  const db = drizzle(client, { schema });

  return {
    async withOrg(fn) {
      return db.transaction(async (tx) => {
        // set_config(name, value, is_local=true) is SET LOCAL but parameterized.
        await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`);
        return fn(tx as unknown as DrizzleDb);
      });
    },
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}

export function getAdminDb(options: ClientOptions = {}): {
  db: DrizzleDb;
  close: () => Promise<void>;
} {
  const client = postgres(resolveUrl(options.url), {
    max: options.max ?? 5,
    prepare: false,
  });
  const db = drizzle(client, { schema });
  return {
    db,
    close: () => client.end({ timeout: 5 }),
  };
}

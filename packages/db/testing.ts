import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { runMigrations } from "./src/migrate";

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://bematist:bematist@localhost:5432/bematist";

function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export interface TempDatabase {
  url: string;
  name: string;
  drop: () => Promise<void>;
}

export async function createTempDatabase(): Promise<TempDatabase> {
  const name = `test_ws1_${randomBytes(4).toString("hex")}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const url = withDatabase(ADMIN_URL, name);

  return {
    url,
    name,
    async drop() {
      const adminAfter = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      try {
        await adminAfter.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
        );
        await adminAfter.unsafe(`DROP DATABASE IF EXISTS ${name}`);
      } finally {
        await adminAfter.end({ timeout: 5 });
      }
    },
  };
}

export async function createMigratedDatabase(): Promise<TempDatabase> {
  const db = await createTempDatabase();
  await runMigrations({ url: db.url });
  return db;
}

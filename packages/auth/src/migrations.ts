import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url).pathname;

export interface ApplyAuthMigrationsOptions {
  url?: string;
}

export async function applyAuthMigrations(
  options: ApplyAuthMigrationsOptions = {},
): Promise<{ applied: string[] }> {
  const url = options.url ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  try {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const filename of files) {
      const body = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
      await sql.unsafe(body);
      applied.push(filename);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return { applied };
}

if (import.meta.main) {
  applyAuthMigrations()
    .then(({ applied }) => {
      console.log(`auth-migrate: applied=${applied.length}`);
      for (const f of applied) console.log(`  applied ${f}`);
    })
    .catch((err) => {
      console.error("auth-migrate failed:", err);
      process.exit(1);
    });
}

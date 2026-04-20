import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { loadPricingSeed } from "./seed";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url).pathname;

export interface RunMigrationsOptions {
  url?: string;
  monthsAhead?: number;
  seedPricing?: boolean;
}

export async function runMigrations(options: RunMigrationsOptions = {}): Promise<{
  applied: string[];
  skipped: string[];
}> {
  const url = options.url ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS __bematist_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

    for (const filename of files) {
      const body = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
      const checksum = createHash("sha256").update(body).digest("hex");
      const existing = await sql<{ checksum: string }[]>`
        SELECT checksum FROM __bematist_migrations WHERE filename = ${filename}
      `;
      if (existing.length > 0) {
        if (existing[0]!.checksum !== checksum) {
          throw new Error(
            `migration ${filename} was applied with a different checksum; refusing to run`,
          );
        }
        skipped.push(filename);
        continue;
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`
          INSERT INTO __bematist_migrations (filename, checksum) VALUES (${filename}, ${checksum})
        `;
      });
      applied.push(filename);
    }

    await sql`SELECT ensure_partitions(${options.monthsAhead ?? 3})`;

    if (options.seedPricing ?? true) {
      await seedPricing(sql);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  return { applied, skipped };
}

async function seedPricing(sql: postgres.Sql): Promise<void> {
  const rows = await loadPricingSeed();
  if (rows.length === 0) return;
  for (const row of rows) {
    await sql`
      INSERT INTO pricing (
        pricing_version, model, provider,
        input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
        effective_from, effective_to
      ) VALUES (
        ${row.pricing_version}, ${row.model}, ${row.provider},
        ${row.input_per_mtok}, ${row.output_per_mtok},
        ${row.cache_read_per_mtok}, ${row.cache_write_per_mtok},
        ${row.effective_from}, ${row.effective_to}
      )
      ON CONFLICT (pricing_version, model, effective_from) DO NOTHING
    `;
  }
}

if (import.meta.main) {
  runMigrations()
    .then(({ applied, skipped }) => {
      console.log(`migrate: applied=${applied.length} skipped=${skipped.length}`);
      for (const f of applied) console.log(`  applied ${f}`);
      for (const f of skipped) console.log(`  skipped ${f}`);
    })
    .catch((err) => {
      console.error("migrate failed:", err);
      process.exit(1);
    });
}

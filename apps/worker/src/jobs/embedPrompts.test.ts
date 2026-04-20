import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMigratedDatabase, type TempDatabase } from "@bematist/db/testing";
import type { EmbeddingProvider } from "@bematist/embed";
import { MINI_LM_DIM, MiniLmProvider } from "@bematist/embed";
import postgres from "postgres";
import { runEmbedOnce, startEmbedLoop } from "./embedPrompts";

let tmp: TempDatabase;
let admin: postgres.Sql;
let orgId = "";
let developerId = "";
let sessionId = "";

const PROMPT_TEXTS = [
  "fix the failing test in the auth module",
  "add a new route to the express server",
  "debug the memory leak in the worker",
  "refactor the database client to use pooling",
  "write documentation for the new API",
  "set up monitoring for the ingest service",
  "investigate why the deploy failed",
  "tune the postgres autovacuum settings",
  "add integration tests for the webhook handler",
  "review the pull request for the billing feature",
];

async function seedPrompts(sql: postgres.Sql, n: number): Promise<void> {
  const rows: Array<{
    org_id: string;
    session_id: string;
    prompt_index: number;
    prompt_text: string;
    prompt_sha256: string;
  }> = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      org_id: orgId,
      session_id: sessionId,
      prompt_index: i,
      prompt_text: PROMPT_TEXTS[i % PROMPT_TEXTS.length] as string,
      prompt_sha256: `sha-${i}`,
    });
  }
  // Insert in chunks of 50 to avoid overly long VALUES lists.
  for (let offset = 0; offset < rows.length; offset += 50) {
    const chunk = rows.slice(offset, offset + 50);
    await sql`
      INSERT INTO prompts ${sql(chunk, "org_id", "session_id", "prompt_index", "prompt_text", "prompt_sha256")}
    `;
  }
}

beforeAll(async () => {
  process.env.BEMATIST_MODEL_CACHE_DIR ??= "/tmp/bematist-xenova-cache";
  tmp = await createMigratedDatabase();
  admin = postgres(tmp.url, { max: 2, onnotice: () => {}, prepare: false });
  const [org] = await admin<{ id: string }[]>`
    INSERT INTO orgs (slug, name) VALUES ('embed-org', 'Embed Org') RETURNING id
  `;
  orgId = org!.id;
  const [dev] = await admin<{ id: string }[]>`
    INSERT INTO developers (org_id, email) VALUES (${orgId}, 'dev@test') RETURNING id
  `;
  developerId = dev!.id;
  const [sess] = await admin<{ id: string }[]>`
    INSERT INTO sessions (org_id, developer_id, source, source_session_id, started_at)
    VALUES (${orgId}, ${developerId}, 'claude-code', 'sess-1', now()) RETURNING id
  `;
  sessionId = sess!.id;
}, 120_000);

afterAll(async () => {
  if (admin) await admin.end({ timeout: 5 });
  if (tmp) await tmp.drop();
});

describe("runEmbedOnce (integration)", () => {
  test(
    "embeds 100 prompts across multiple batches and leaves none NULL",
    async () => {
      await admin`DELETE FROM prompts`;
      await seedPrompts(admin, 100);
      const before = await admin<{ c: number }[]>`
        SELECT count(*)::int AS c FROM prompts WHERE embedding IS NULL
      `;
      expect(before[0]?.c).toBe(100);

      const result = await runEmbedOnce({
        sql: admin,
        provider: MiniLmProvider,
        batchSize: 32,
      });
      expect(result.scanned).toBe(100);
      expect(result.embedded).toBe(100);
      expect(result.batches).toBe(4);
      expect(result.failedBatches).toBe(0);

      const after = await admin<{ c: number; nulls: number }[]>`
        SELECT count(*)::int AS c,
               sum(CASE WHEN embedding IS NULL THEN 1 ELSE 0 END)::int AS nulls
        FROM prompts
      `;
      expect(after[0]?.c).toBe(100);
      expect(after[0]?.nulls).toBe(0);
    },
    { timeout: 120_000 },
  );

  test(
    "caps work per tick at maxPerTick",
    async () => {
      await admin`DELETE FROM prompts`;
      await seedPrompts(admin, 50);
      const result = await runEmbedOnce({
        sql: admin,
        provider: MiniLmProvider,
        batchSize: 32,
        maxPerTick: 20,
      });
      expect(result.scanned).toBe(20);
      expect(result.embedded).toBe(20);
      const remaining = await admin<{ c: number }[]>`
        SELECT count(*)::int AS c FROM prompts WHERE embedding IS NULL
      `;
      expect(remaining[0]?.c).toBe(30);
    },
    { timeout: 60_000 },
  );

  test("scanned=0 when no work available", async () => {
    await admin`DELETE FROM prompts`;
    const result = await runEmbedOnce({ sql: admin, provider: MiniLmProvider });
    expect(result).toEqual({ scanned: 0, embedded: 0, batches: 0, failedBatches: 0 });
  });

  test(
    "a failing batch does not lose work from other batches",
    async () => {
      await admin`DELETE FROM prompts`;
      await seedPrompts(admin, 40);

      // Provider that fails the first batch but embeds the rest.
      let call = 0;
      const flaky: EmbeddingProvider = {
        name: "flaky",
        dim: MINI_LM_DIM,
        async embed(text) {
          return MiniLmProvider.embed(text);
        },
        async embedBatch(texts) {
          call++;
          if (call === 1) throw new Error("injected batch failure");
          return MiniLmProvider.embedBatch(texts);
        },
      };

      const result = await runEmbedOnce({
        sql: admin,
        provider: flaky,
        batchSize: 32,
      });
      // 40 prompts at batchSize=32 -> 2 batches. First fails, second (8 rows) succeeds.
      expect(result.batches).toBe(2);
      expect(result.failedBatches).toBe(1);
      expect(result.embedded).toBe(8);

      const pending = await admin<{ c: number }[]>`
        SELECT count(*)::int AS c FROM prompts WHERE embedding IS NULL
      `;
      expect(pending[0]?.c).toBe(32);
    },
    { timeout: 60_000 },
  );
});

describe("startEmbedLoop SIGTERM-style drain", () => {
  test(
    "stop() awaits the in-flight tick before resolving",
    async () => {
      await admin`DELETE FROM prompts`;
      await seedPrompts(admin, 8);

      let resolveInFlight: () => void = () => {};
      const gate = new Promise<void>((r) => {
        resolveInFlight = r;
      });

      const slow: EmbeddingProvider = {
        name: "slow",
        dim: MINI_LM_DIM,
        embed: MiniLmProvider.embed,
        async embedBatch(texts) {
          await gate;
          return MiniLmProvider.embedBatch(texts);
        },
      };

      const handle = startEmbedLoop({
        sql: admin,
        provider: slow,
        intervalMs: 10,
      });
      // Give the interval a chance to fire a tick.
      await new Promise((r) => setTimeout(r, 40));

      const stopPromise = handle.stop();
      let stopped = false;
      void stopPromise.then(() => {
        stopped = true;
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(stopped).toBe(false);

      // Release the in-flight embed so the tick can drain.
      resolveInFlight();
      await stopPromise;
      expect(stopped).toBe(true);

      const pending = await admin<{ c: number }[]>`
        SELECT count(*)::int AS c FROM prompts WHERE embedding IS NULL
      `;
      // The in-flight batch must have flushed before stop() returned.
      expect(pending[0]?.c).toBe(0);
    },
    { timeout: 60_000 },
  );
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { createMigratedDatabase, type TempDatabase } from "./testing";

let tmp: TempDatabase;
let admin: postgres.Sql;
let orgId = "";
let sessionId = "";

function randomVec(dim: number): string {
  const parts: string[] = [];
  for (let i = 0; i < dim; i++) parts.push((Math.random() - 0.5).toFixed(6));
  return `[${parts.join(",")}]`;
}

beforeAll(async () => {
  tmp = await createMigratedDatabase();
  admin = postgres(tmp.url, { max: 1, onnotice: () => {} });

  const [org] = await admin<{ id: string }[]>`
    INSERT INTO orgs (slug, name) VALUES ('vector-org', 'Vector Org') RETURNING id
  `;
  orgId = org!.id;
  const [dev] = await admin<{ id: string }[]>`
    INSERT INTO developers (org_id, email) VALUES (${orgId}, 'v@test') RETURNING id
  `;
  const [sess] = await admin<{ id: string }[]>`
    INSERT INTO sessions (org_id, developer_id, source, source_session_id, started_at)
    VALUES (${orgId}, ${dev!.id}, 'claude-code', 'sess-1', now()) RETURNING id
  `;
  sessionId = sess!.id;

  for (let i = 0; i < 20; i++) {
    const vec = randomVec(384);
    await admin`
      INSERT INTO prompts (org_id, session_id, prompt_index, prompt_text, prompt_sha256, embedding)
      VALUES (${orgId}, ${sessionId}, ${i}, ${`prompt-${i}`}, ${`sha-${i}`}, ${vec}::vector(384))
    `;
  }
  await admin`SET hnsw.ef_search = 40`;
});

afterAll(async () => {
  if (admin) await admin.end({ timeout: 5 });
  if (tmp) await tmp.drop();
});

test("HNSW index exists on prompts.embedding with cosine ops", async () => {
  const rows = await admin<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
    WHERE tablename = 'prompts' AND indexname = 'prompts_embedding_hnsw'
  `;
  expect(rows.length).toBe(1);
  expect(rows[0]!.indexdef).toMatch(/USING hnsw/);
  expect(rows[0]!.indexdef).toMatch(/vector_cosine_ops/);
});

test("partitions inherit the HNSW index for prompts", async () => {
  const rows = await admin<{ tablename: string; indexname: string }[]>`
    SELECT tablename, indexname FROM pg_indexes
    WHERE tablename LIKE 'prompts_______'
      AND indexdef LIKE '%hnsw%'
  `;
  expect(rows.length).toBeGreaterThanOrEqual(1);
});

test("cosine <=> query against a partition uses the HNSW index", async () => {
  const vec = randomVec(384);
  // Pick the partition the inserts landed in (current month).
  const partitions = await admin<{ child: string }[]>`
    SELECT c.relname AS child
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'prompts'
      AND to_char(now(), 'YYYYMM') = substring(c.relname from 9)
  `;
  expect(partitions.length).toBe(1);
  const partition = partitions[0]!.child;
  await admin.unsafe(`SET enable_seqscan = off`);
  const plan = await admin.unsafe(
    `EXPLAIN (ANALYZE, FORMAT TEXT) SELECT id FROM ${partition} ORDER BY embedding <=> '${vec}'::vector(384) LIMIT 5`,
  );
  const text = (plan as unknown as { "QUERY PLAN": string }[])
    .map((r) => r["QUERY PLAN"])
    .join("\n");
  expect(text).toMatch(/Index Scan using .*embedding/);
  // Belt + suspenders: confirm the chosen index is actually HNSW, not btree.
  const chosen = text.match(/Index Scan using (\S+)/)?.[1];
  expect(chosen).toBeDefined();
  const [idxMeta] = await admin<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE indexname = ${chosen!}
  `;
  expect(idxMeta).toBeDefined();
  expect(idxMeta!.indexdef).toMatch(/USING hnsw/);
});

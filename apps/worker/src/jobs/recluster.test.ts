import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMigratedDatabase, type TempDatabase } from "@bematist/db/testing";
import { MiniLmProvider } from "@bematist/embed";
import postgres from "postgres";
import { runEmbedOnce } from "./embedPrompts";
import { runReclusterOnce } from "./recluster";

let tmp: TempDatabase;
let admin: postgres.Sql;
let orgId = "";
let sessionId = "";

const CLUSTERED_PROMPTS = [
  // cluster A: testing
  "fix the failing unit test",
  "debug the flaky integration test",
  "add more test coverage for auth flows",
  "write a regression test for the null-deref bug",
  "run the test suite against postgres 16",
  "resolve the jest snapshot diff in ci",
  // cluster B: billing
  "implement monthly billing webhook for stripe",
  "add invoice generation for pro plan",
  "fix billing cycle rollover on plan upgrade",
  "send dunning emails when a payment fails",
  "add tax calculation for eu customers",
  "implement usage-based billing for api calls",
  // cluster C: docs
  "update the README with install instructions",
  "document the new embedding worker jobs",
  "write a tutorial for the ingest binary",
  "improve the API reference for v1 endpoints",
  "add jsdoc comments to the auth module",
  "create a quickstart guide for new users",
];

beforeAll(async () => {
  process.env.BEMATIST_MODEL_CACHE_DIR ??= "/tmp/bematist-xenova-cache";
  tmp = await createMigratedDatabase();
  admin = postgres(tmp.url, { max: 2, onnotice: () => {}, prepare: false });
  const [org] = await admin<{ id: string }[]>`
    INSERT INTO orgs (slug, name) VALUES ('cluster-org', 'Cluster Org') RETURNING id
  `;
  orgId = org!.id;
  const [dev] = await admin<{ id: string }[]>`
    INSERT INTO developers (org_id, email) VALUES (${orgId}, 'dev@cluster') RETURNING id
  `;
  const [sess] = await admin<{ id: string }[]>`
    INSERT INTO sessions (org_id, developer_id, source, source_session_id, started_at)
    VALUES (${orgId}, ${dev!.id}, 'claude-code', 'cluster-sess', now()) RETURNING id
  `;
  sessionId = sess!.id;

  const rows = CLUSTERED_PROMPTS.map((text, i) => ({
    org_id: orgId,
    session_id: sessionId,
    prompt_index: i,
    prompt_text: text,
    prompt_sha256: `sha-${i}`,
  }));
  await admin`
    INSERT INTO prompts ${admin(rows, "org_id", "session_id", "prompt_index", "prompt_text", "prompt_sha256")}
  `;

  await runEmbedOnce({ sql: admin, provider: MiniLmProvider, batchSize: 32 });
}, 180_000);

afterAll(async () => {
  if (admin) await admin.end({ timeout: 5 });
  if (tmp) await tmp.drop();
});

describe("runReclusterOnce (integration)", () => {
  test("produces prompt_clusters rows and populates prompts.cluster_id", async () => {
    const result = await runReclusterOnce({ sql: admin, seed: 7 });
    expect(result.orgs.length).toBe(1);
    const org = result.orgs[0]!;
    expect(org.orgId).toBe(orgId);
    expect(org.prompts).toBe(CLUSTERED_PROMPTS.length);
    expect(org.clusters).toBeGreaterThanOrEqual(3);
    expect(org.clusters).toBeLessThanOrEqual(5);

    const clusterRows = await admin<{ id: string; size: number; label: string }[]>`
      SELECT id, size, label FROM prompt_clusters WHERE org_id = ${orgId}
    `;
    expect(clusterRows.length).toBe(org.clusters);
    for (const r of clusterRows) {
      expect(r.label.length).toBeLessThanOrEqual(80);
      expect(r.size).toBeGreaterThan(0);
    }

    const assigned = await admin<{ assigned: number; unassigned: number }[]>`
      SELECT
        sum(CASE WHEN cluster_id IS NOT NULL THEN 1 ELSE 0 END)::int AS assigned,
        sum(CASE WHEN cluster_id IS NULL THEN 1 ELSE 0 END)::int AS unassigned
      FROM prompts
      WHERE org_id = ${orgId}
    `;
    expect(assigned[0]?.assigned).toBe(CLUSTERED_PROMPTS.length);
    expect(assigned[0]?.unassigned).toBe(0);
  });

  test("groups the three seeded topic families into distinct majority clusters", async () => {
    type Row = { prompt_index: number; cluster_id: string | null };
    const queried = await admin<Row[]>`
      SELECT prompt_index, cluster_id FROM prompts
      WHERE org_id = ${orgId}
      ORDER BY prompt_index
    `;
    const rows: Row[] = [...queried];
    expect(rows.length).toBe(CLUSTERED_PROMPTS.length);

    function majorityCluster(slice: Row[]): string {
      const tally = new Map<string, number>();
      for (const r of slice) {
        if (!r.cluster_id) continue;
        tally.set(r.cluster_id, (tally.get(r.cluster_id) ?? 0) + 1);
      }
      let bestId = "";
      let bestCount = 0;
      for (const [id, count] of tally) {
        if (count > bestCount) {
          bestCount = count;
          bestId = id;
        }
      }
      return bestId;
    }

    const majA = majorityCluster(rows.slice(0, 6));
    const majB = majorityCluster(rows.slice(6, 12));
    const majC = majorityCluster(rows.slice(12, 18));

    expect(new Set([majA, majB, majC]).size).toBe(3);

    const countIn = (slice: Row[], id: string) => slice.filter((r) => r.cluster_id === id).length;
    expect(countIn(rows.slice(0, 6), majA)).toBeGreaterThanOrEqual(3);
    expect(countIn(rows.slice(6, 12), majB)).toBeGreaterThanOrEqual(3);
    expect(countIn(rows.slice(12, 18), majC)).toBeGreaterThanOrEqual(3);
  });

  test("idempotent — running twice does not duplicate cluster rows", async () => {
    await runReclusterOnce({ sql: admin, seed: 7 });
    await runReclusterOnce({ sql: admin, seed: 7 });
    const rows = await admin<{ c: number }[]>`
      SELECT count(*)::int AS c FROM prompt_clusters WHERE org_id = ${orgId}
    `;
    // Should equal the final cluster count, not a multiple of it.
    expect(rows[0]?.c).toBeLessThanOrEqual(5);
    expect(rows[0]?.c).toBeGreaterThanOrEqual(3);
  });
});

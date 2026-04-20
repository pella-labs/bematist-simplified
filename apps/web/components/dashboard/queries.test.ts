import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getAdminDb } from "@bematist/db";
import { createMigratedDatabase, type TempDatabase } from "@bematist/db/testing";
import {
  findDeveloperForUser,
  getCompareItem,
  getDeveloper,
  getOverviewCounts,
  getSessionDetail,
  listDevelopers,
  listIngestKeys,
  listPromptClusters,
  listSessions,
  listUsers,
} from "./queries";

let tmp: TempDatabase;
let orgAId: string;
let orgBId: string;
let devAliceId: string;
let devBobId: string;
let devOtherId: string;
let userAliceId: string;
let userOtherId: string;
let sessionAliceId: string;
let sessionBobId: string;
let prId: string;

function appUrl(url: string): string {
  const u = new URL(url);
  u.username = "app_bematist";
  u.password = "app_bematist_dev";
  return u.toString();
}

beforeAll(async () => {
  tmp = await createMigratedDatabase();
  process.env.DATABASE_URL = appUrl(tmp.url);
  process.env.ADMIN_DATABASE_URL = tmp.url;
  const { db: admin, close } = getAdminDb({ url: tmp.url });
  try {
    orgAId = randomUUID();
    orgBId = randomUUID();
    devAliceId = randomUUID();
    devBobId = randomUUID();
    devOtherId = randomUUID();
    userAliceId = randomUUID();
    userOtherId = randomUUID();
    sessionAliceId = randomUUID();
    sessionBobId = randomUUID();
    prId = randomUUID();
    const repoId = randomUUID();
    const clusterId = randomUUID();

    await admin.execute(
      `INSERT INTO orgs (id, slug, name) VALUES ('${orgAId}', 'org-a', 'Org A'), ('${orgBId}', 'org-b', 'Org B')` as never,
    );
    await admin.execute(
      `INSERT INTO users (id, org_id, better_auth_user_id, email, name, role) VALUES
        ('${userAliceId}', '${orgAId}', 'ba_alice', 'alice@example.com', 'Alice', 'admin'),
        ('${userOtherId}', '${orgAId}', 'ba_other', 'other@example.com', 'Other', 'member')` as never,
    );
    await admin.execute(
      `INSERT INTO developers (id, org_id, user_id, email, name, subscription_claude) VALUES
        ('${devAliceId}', '${orgAId}', '${userAliceId}', 'alice@example.com', 'Alice', 'max_200'),
        ('${devBobId}', '${orgAId}', null, 'bob@example.com', 'Bob', null),
        ('${devOtherId}', '${orgBId}', null, 'x@other.com', 'X', null)` as never,
    );
    await admin.execute(
      `INSERT INTO ingest_keys (id, org_id, developer_id, key_sha256) VALUES
        ('bm_test_alice', '${orgAId}', '${devAliceId}', 'sha-alice'),
        ('bm_test_bob', '${orgAId}', '${devBobId}', 'sha-bob')` as never,
    );
    await admin.execute(
      `INSERT INTO github_installations (org_id, installation_id, status) VALUES ('${orgAId}', 1, 'active')` as never,
    );
    await admin.execute(
      `INSERT INTO repos (id, org_id, installation_id, github_repo_id, name, default_branch) VALUES ('${repoId}', '${orgAId}', 1, 42, 'org-a/demo', 'main')` as never,
    );
    await admin.execute(
      `INSERT INTO github_prs (id, org_id, repo_id, number, title, state, merged_at, head_sha) VALUES ('${prId}', '${orgAId}', '${repoId}', 1, 'Feat', 'closed', now(), 'abc1234')` as never,
    );
    await admin.execute(
      `INSERT INTO github_commits (org_id, repo_id, sha, message, committed_at, pr_id) VALUES ('${orgAId}', '${repoId}', 'abc1234', 'feat: thing\n\nBematist-Session: xxx', now(), '${prId}')` as never,
    );

    const now = new Date();
    const iso = now.toISOString();
    await admin.execute(
      `INSERT INTO sessions (id, org_id, developer_id, source, source_session_id, started_at, cwd) VALUES
        ('${sessionAliceId}', '${orgAId}', '${devAliceId}', 'claude-code', 'ssn-alice', '${iso}', '/repo/demo'),
        ('${sessionBobId}', '${orgAId}', '${devBobId}', 'codex', 'ssn-bob', '${iso}', '/repo/demo')` as never,
    );

    await admin.execute(
      `INSERT INTO prompt_clusters (id, org_id, size, label) VALUES ('${clusterId}', '${orgAId}', 2, 'Refactor prompts')` as never,
    );

    const promptAliceId = randomUUID();
    const promptBobId = randomUUID();
    await admin.execute(
      `INSERT INTO prompts (id, org_id, session_id, prompt_index, prompt_text, prompt_sha256, cluster_id, created_at) VALUES
        ('${promptAliceId}', '${orgAId}', '${sessionAliceId}', 0, 'Refactor the button', 'sha-a', '${clusterId}', '${iso}'),
        ('${promptBobId}', '${orgAId}', '${sessionBobId}', 0, 'Refactor the form', 'sha-b', '${clusterId}', '${iso}')` as never,
    );

    await admin.execute(
      `INSERT INTO events (id, org_id, developer_id, session_id, event_seq, ts, kind, cost_usd, input_tokens, output_tokens, client_event_id, prompt_id) VALUES
        ('${randomUUID()}', '${orgAId}', '${devAliceId}', '${sessionAliceId}', 1, '${iso}', 'user_prompt', 1.5, 1000, 500, '${randomUUID()}', '${promptAliceId}'),
        ('${randomUUID()}', '${orgAId}', '${devAliceId}', '${sessionAliceId}', 2, '${iso}', 'assistant_response', 2.25, 0, 1200, '${randomUUID()}', null),
        ('${randomUUID()}', '${orgAId}', '${devBobId}', '${sessionBobId}', 1, '${iso}', 'user_prompt', 0.5, 500, 300, '${randomUUID()}', '${promptBobId}')` as never,
    );

    await admin.execute(
      `INSERT INTO session_commit_links (org_id, session_id, commit_sha, signal) VALUES
        ('${orgAId}', '${sessionAliceId}', 'abc1234', 'trailer'),
        ('${orgAId}', '${sessionAliceId}', 'abc1234', 'cwd_time')` as never,
    );

    // Another org's developer to prove RLS filters it out when scoped to orgA.
  } finally {
    await close();
  }
});

afterAll(async () => {
  if (tmp) await tmp.drop();
});

describe("getOverviewCounts", () => {
  test("aggregates in-month cost, tokens, sessions, merged PRs", async () => {
    const counts = await getOverviewCounts(orgAId);
    expect(counts.totalCostUsd).toBeCloseTo(4.25, 2);
    expect(counts.totalTokensInput).toBe(1500);
    expect(counts.totalTokensOutput).toBe(2000);
    expect(counts.sessionCount).toBe(2);
    expect(counts.eventCount).toBe(3);
    expect(counts.mergedPrCount).toBe(1);
    expect(counts.activeDeveloperCount).toBe(2);
  });

  test("RLS: foreign org sees zero sessions and zero cost", async () => {
    const counts = await getOverviewCounts(orgBId);
    expect(counts.sessionCount).toBe(0);
    expect(counts.totalCostUsd).toBe(0);
    expect(counts.mergedPrCount).toBe(0);
  });
});

describe("listDevelopers", () => {
  test("returns per-developer sessions and monthly cost for my org", async () => {
    const devs = await listDevelopers(orgAId);
    expect(devs).toHaveLength(2);
    const alice = devs.find((d) => d.name === "Alice");
    expect(alice).toBeDefined();
    expect(alice!.sessionCount).toBe(1);
    expect(alice!.monthlyCostUsd).toBeCloseTo(3.75, 2);
    expect(alice!.subscriptionClaude).toBe("max_200");
  });

  test("RLS: foreign org sees only its own developers", async () => {
    const devs = await listDevelopers(orgBId);
    expect(devs).toHaveLength(1);
    expect(devs[0]!.email).toBe("x@other.com");
  });
});

describe("findDeveloperForUser", () => {
  test("resolves the developer linked by userId", async () => {
    const dev = await findDeveloperForUser(orgAId, userAliceId, "alice@example.com");
    expect(dev?.id).toBe(devAliceId);
  });

  test("returns null for a non-linked user with no matching email", async () => {
    const dev = await findDeveloperForUser(orgAId, userOtherId, "other@example.com");
    expect(dev).toBeNull();
  });
});

describe("listSessions", () => {
  test("returns sessions with aggregated cost, tokens, and signals", async () => {
    const rows = await listSessions(orgAId);
    expect(rows).toHaveLength(2);
    const alice = rows.find((s) => s.id === sessionAliceId)!;
    expect(alice.costUsd).toBeCloseTo(3.75, 2);
    expect(alice.tokensInput).toBe(1000);
    expect(alice.tokensOutput).toBe(1700);
    expect(alice.signals.sort()).toEqual(["cwd_time", "trailer"]);
    expect(alice.commitCount).toBe(1);
  });

  test("filters by developerId", async () => {
    const rows = await listSessions(orgAId, { developerId: devBobId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.developerEmail).toBe("bob@example.com");
  });

  test("filters by source", async () => {
    const rows = await listSessions(orgAId, { source: "codex" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("codex");
  });
});

describe("getSessionDetail", () => {
  test("returns transcript, commits, and signals", async () => {
    const detail = await getSessionDetail(orgAId, sessionAliceId);
    expect(detail).not.toBeNull();
    expect(detail!.transcript.length).toBeGreaterThanOrEqual(2);
    const userPrompt = detail!.transcript.find((e) => e.kind === "user_prompt");
    expect(userPrompt?.promptText).toBe("Refactor the button");
    expect(detail!.commits).toHaveLength(1);
    expect(detail!.commits[0]!.sha).toBe("abc1234");
    expect(detail!.commits[0]!.signals.sort()).toEqual(["cwd_time", "trailer"]);
    expect(detail!.commits[0]!.prNumber).toBe(1);
  });

  test("returns null for unknown session", async () => {
    const detail = await getSessionDetail(orgAId, randomUUID());
    expect(detail).toBeNull();
  });
});

describe("listPromptClusters", () => {
  test("returns one cluster row per cluster_id with merge counts", async () => {
    const rows = await listPromptClusters(orgAId);
    const labeled = rows.find((r) => r.label === "Refactor prompts");
    expect(labeled).toBeDefined();
    expect(labeled!.promptCount).toBe(2);
    expect(labeled!.sessionCount).toBe(2);
    expect(labeled!.mergedSessionCount).toBeGreaterThanOrEqual(1);
  });
});

describe("getDeveloper and authorization helpers", () => {
  test("getDeveloper returns a matching developer in-org", async () => {
    const dev = await getDeveloper(orgAId, devAliceId);
    expect(dev?.email).toBe("alice@example.com");
  });

  test("getDeveloper returns null for dev in a different org", async () => {
    const dev = await getDeveloper(orgAId, devOtherId);
    expect(dev).toBeNull();
  });
});

describe("listUsers + listIngestKeys", () => {
  test("listUsers returns all users in the org", async () => {
    const us = await listUsers(orgAId);
    expect(us).toHaveLength(2);
    expect(us.some((u) => u.role === "admin")).toBe(true);
  });
  test("listIngestKeys returns keys with developer info", async () => {
    const ks = await listIngestKeys(orgAId);
    expect(ks).toHaveLength(2);
    expect(ks.some((k) => k.developerEmail === "alice@example.com")).toBe(true);
  });
});

describe("getCompareItem", () => {
  test("compare session returns cost, tokens, cluster, merged count", async () => {
    const item = await getCompareItem(orgAId, "session", sessionAliceId);
    expect(item).not.toBeNull();
    expect(item!.kind).toBe("session");
    expect(item!.mergedCommitCount).toBe(1);
    expect(item!.clusterId).not.toBeNull();
  });

  test("compare cluster returns summary shape", async () => {
    const clusters = await listPromptClusters(orgAId);
    const clusterWithId = clusters.find((c) => c.clusterId !== null);
    expect(clusterWithId).toBeDefined();
    const item = await getCompareItem(orgAId, "cluster", clusterWithId!.clusterId!);
    expect(item?.kind).toBe("cluster");
    expect(item?.eventCount).toBe(clusterWithId!.promptCount);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createMigratedDatabase, type TempDatabase } from "@bematist/db/testing";
import postgres from "postgres";
import { cwdMatchesRepo, runCwdTimeAttribution } from "./attribute-cwd-time";

let tmp: TempDatabase;
let admin: postgres.Sql;
let orgId = "";
let installationId = 0;
let developerId = "";

async function createRepo(name: string, githubRepoId?: number): Promise<string> {
  const id = randomUUID();
  const gid = githubRepoId ?? Math.floor(Math.random() * 1_000_000);
  await admin`
    INSERT INTO repos (id, org_id, installation_id, github_repo_id, name)
    VALUES (${id}, ${orgId}, ${installationId}, ${gid}, ${name})
  `;
  return id;
}

async function createCommit(
  repoId: string,
  sha: string,
  committedAt: Date,
  authorEmail = "x@ex.com",
): Promise<void> {
  await admin`
    INSERT INTO github_commits (org_id, repo_id, sha, author_email, committed_at, message)
    VALUES (${orgId}, ${repoId}, ${sha}, ${authorEmail}, ${committedAt}, 'x')
  `;
}

async function createSession(
  startedAt: Date,
  endedAt: Date | null,
  cwd: string | null,
): Promise<string> {
  const id = randomUUID();
  await admin`
    INSERT INTO sessions (id, org_id, developer_id, source, source_session_id, started_at, ended_at, cwd)
    VALUES (${id}, ${orgId}, ${developerId}, 'claude-code', ${`src-${id.slice(0, 8)}`}, ${startedAt}, ${endedAt}, ${cwd})
  `;
  return id;
}

beforeAll(async () => {
  tmp = await createMigratedDatabase();
  admin = postgres(tmp.url, { max: 2, onnotice: () => {}, prepare: false });
  const [org] = await admin<{ id: string }[]>`
    INSERT INTO orgs (slug, name) VALUES ('cwd-org', 'CWD Org') RETURNING id
  `;
  orgId = org!.id;
  installationId = Math.floor(Math.random() * 1_000_000_00);
  await admin`
    INSERT INTO github_installations (org_id, installation_id, status)
    VALUES (${orgId}, ${installationId}, 'active')
  `;
  const [dev] = await admin<{ id: string }[]>`
    INSERT INTO developers (org_id, email) VALUES (${orgId}, 'alice@ex.com') RETURNING id
  `;
  developerId = dev!.id;
});

afterAll(async () => {
  if (admin) await admin.end({ timeout: 5 });
  if (tmp) await tmp.drop();
});

beforeEach(async () => {
  await admin`DELETE FROM session_commit_links`;
  await admin`DELETE FROM github_commits`;
  await admin`DELETE FROM sessions`;
  await admin`DELETE FROM repos`;
});

describe("cwdMatchesRepo", () => {
  test("matches when repo short name is a path segment", () => {
    expect(
      cwdMatchesRepo("/Users/alice/dev/bematist-simplified", "pella-labs/bematist-simplified"),
    ).toBe(true);
  });
  test("does not match a path that lacks the repo name", () => {
    expect(cwdMatchesRepo("/Users/alice/dev/other-repo", "pella-labs/bematist-simplified")).toBe(
      false,
    );
  });
  test("case-insensitive", () => {
    expect(
      cwdMatchesRepo("/Users/Alice/Dev/Bematist-Simplified", "pella/bematist-simplified"),
    ).toBe(true);
  });
  test("handles Windows-style paths", () => {
    expect(cwdMatchesRepo("C:\\Users\\alice\\dev\\bematist", "pella/bematist")).toBe(true);
  });
});

describe("runCwdTimeAttribution", () => {
  test("links session → commit when cwd matches repo name and commit is in window", async () => {
    const repoId = await createRepo("pella-labs/myrepo", 2001);
    const now = new Date("2026-04-20T12:00:00Z");
    const session = await createSession(
      new Date(now.getTime() - 15 * 60 * 1000),
      new Date(now.getTime() - 5 * 60 * 1000),
      "/Users/alice/dev/myrepo",
    );
    await createCommit(repoId, `a${"0".repeat(39)}`, new Date(now.getTime() - 10 * 60 * 1000));

    const res = await runCwdTimeAttribution({ sql: admin, now: () => now });
    expect(res.linked).toBe(1);
    const rows = await admin<{ session_id: string; signal: string }[]>`
      SELECT session_id, signal FROM session_commit_links
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.session_id).toBe(session);
    expect(rows[0]?.signal).toBe("cwd_time");
  });

  test("no link when commit is outside the time window", async () => {
    const repoId = await createRepo("pella-labs/myrepo2", 2002);
    const now = new Date("2026-04-20T12:00:00Z");
    await createSession(
      new Date(now.getTime() - 15 * 60 * 1000),
      new Date(now.getTime() - 5 * 60 * 1000),
      "/Users/alice/dev/myrepo2",
    );
    // Commit 30 min after session end.
    await createCommit(repoId, `b${"0".repeat(39)}`, new Date(now.getTime() + 30 * 60 * 1000));

    const res = await runCwdTimeAttribution({ sql: admin, now: () => now });
    expect(res.linked).toBe(0);
  });

  test("no link when session cwd does not contain any repo name", async () => {
    const repoId = await createRepo("pella-labs/known", 2003);
    const now = new Date("2026-04-20T12:00:00Z");
    await createSession(
      new Date(now.getTime() - 10 * 60 * 1000),
      new Date(now.getTime()),
      "/Users/alice/dev/unrelated",
    );
    await createCommit(repoId, `c${"0".repeat(39)}`, new Date(now.getTime() - 5 * 60 * 1000));

    const res = await runCwdTimeAttribution({ sql: admin, now: () => now });
    expect(res.linked).toBe(0);
  });

  test("skips sessions outside the lookback window", async () => {
    const repoId = await createRepo("pella-labs/stale", 2004);
    const now = new Date("2026-04-20T12:00:00Z");
    // Session from 4h ago.
    await createSession(
      new Date(now.getTime() - 4 * 60 * 60 * 1000),
      new Date(now.getTime() - 4 * 60 * 60 * 1000 + 5 * 60 * 1000),
      "/Users/alice/dev/stale",
    );
    await createCommit(repoId, `d${"0".repeat(39)}`, new Date(now.getTime() - 4 * 60 * 60 * 1000));

    const res = await runCwdTimeAttribution({ sql: admin, now: () => now });
    expect(res.sessionsScanned).toBe(0);
    expect(res.linked).toBe(0);
  });

  test("is idempotent across repeated runs", async () => {
    const repoId = await createRepo("pella-labs/idemp", 2005);
    const now = new Date("2026-04-20T12:00:00Z");
    await createSession(
      new Date(now.getTime() - 10 * 60 * 1000),
      new Date(now.getTime() - 5 * 60 * 1000),
      "/Users/alice/dev/idemp",
    );
    await createCommit(repoId, `e${"0".repeat(39)}`, new Date(now.getTime() - 7 * 60 * 1000));

    await runCwdTimeAttribution({ sql: admin, now: () => now });
    const second = await runCwdTimeAttribution({ sql: admin, now: () => now });
    expect(second.linked).toBe(0);
    const rows = await admin<{ c: number }[]>`
      SELECT count(*)::int AS c FROM session_commit_links
    `;
    expect(rows[0]?.c).toBe(1);
  });
});

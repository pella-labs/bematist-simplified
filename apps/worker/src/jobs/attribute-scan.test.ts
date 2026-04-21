import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createMigratedDatabase, type TempDatabase } from "@bematist/db/testing";
import postgres from "postgres";
import { runScanAttribution } from "./attribute-scan";

let tmp: TempDatabase;
let admin: postgres.Sql;
let orgId = "";

async function createDeveloper(email: string): Promise<string> {
  const [d] = await admin<{ id: string }[]>`
    INSERT INTO developers (org_id, email) VALUES (${orgId}, ${email}) RETURNING id
  `;
  return d!.id;
}

async function createSession(
  developerId: string,
  startedAt: Date,
  endedAt: Date | null = null,
  cwd: string | null = null,
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
    INSERT INTO orgs (slug, name) VALUES ('scan-org', 'Scan Org') RETURNING id
  `;
  orgId = org!.id;
});

afterAll(async () => {
  if (admin) await admin.end({ timeout: 5 });
  if (tmp) await tmp.drop();
});

beforeEach(async () => {
  await admin`DELETE FROM session_commit_links`;
  await admin`DELETE FROM sessions`;
  await admin`DELETE FROM developers`;
});

describe("runScanAttribution", () => {
  test("links a commit whose author email matches a session and time is inside window", async () => {
    const dev = await createDeveloper("alice@ex.com");
    const start = new Date("2026-04-20T12:00:00Z");
    const end = new Date("2026-04-20T12:30:00Z");
    const session = await createSession(dev, start, end);
    const sha = `a${"0".repeat(39)}`;

    const res = await runScanAttribution({
      sql: admin,
      orgId,
      commits: [
        {
          sha,
          message: "no trailer\n",
          authorEmail: "alice@ex.com",
          committedAt: new Date("2026-04-20T12:15:00Z"),
        },
      ],
    });
    expect(res.linked).toBe(1);
    const rows = await admin<{ session_id: string; signal: string }[]>`
      SELECT session_id, signal FROM session_commit_links WHERE commit_sha = ${sha}
    `;
    expect(rows[0]?.session_id).toBe(session);
    expect(rows[0]?.signal).toBe("webhook_scan");
  });

  test("skips commits with a valid Bematist-Session trailer (trailer path owns those)", async () => {
    const dev = await createDeveloper("alice@ex.com");
    const start = new Date("2026-04-20T12:00:00Z");
    const end = new Date("2026-04-20T12:30:00Z");
    const session = await createSession(dev, start, end);
    const sha = `b${"0".repeat(39)}`;
    const res = await runScanAttribution({
      sql: admin,
      orgId,
      commits: [
        {
          sha,
          message: `x\n\nBematist-Session: ${session}\n`,
          authorEmail: "alice@ex.com",
          committedAt: new Date("2026-04-20T12:10:00Z"),
        },
      ],
    });
    expect(res.linked).toBe(0);
    expect(res.considered).toBe(0);
  });

  test("no link when author email doesn't match any developer", async () => {
    const dev = await createDeveloper("alice@ex.com");
    const start = new Date("2026-04-20T12:00:00Z");
    const end = new Date("2026-04-20T12:30:00Z");
    await createSession(dev, start, end);
    const res = await runScanAttribution({
      sql: admin,
      orgId,
      commits: [
        {
          sha: `c${"0".repeat(39)}`,
          message: "no trailer\n",
          authorEmail: "unknown@ex.com",
          committedAt: new Date("2026-04-20T12:15:00Z"),
        },
      ],
    });
    expect(res.linked).toBe(0);
  });

  test("no link when committed_at is outside the ±window", async () => {
    const dev = await createDeveloper("alice@ex.com");
    const start = new Date("2026-04-20T12:00:00Z");
    const end = new Date("2026-04-20T12:30:00Z");
    await createSession(dev, start, end);
    const res = await runScanAttribution({
      sql: admin,
      orgId,
      commits: [
        {
          sha: `d${"0".repeat(39)}`,
          message: "no trailer\n",
          authorEmail: "alice@ex.com",
          // 30 min after end — outside 10m window by default
          committedAt: new Date("2026-04-20T13:00:00Z"),
        },
      ],
      windowMs: 10 * 60 * 1000,
    });
    expect(res.linked).toBe(0);
  });

  test("links against an open-ended session (ended_at null) as long as started_at is in range", async () => {
    const dev = await createDeveloper("alice@ex.com");
    const start = new Date(Date.now() - 5 * 60 * 1000);
    const session = await createSession(dev, start, null);
    const res = await runScanAttribution({
      sql: admin,
      orgId,
      commits: [
        {
          sha: `e${"0".repeat(39)}`,
          message: "no trailer\n",
          authorEmail: "alice@ex.com",
          committedAt: new Date(),
        },
      ],
    });
    expect(res.linked).toBe(1);
    const row = await admin<{ session_id: string }[]>`
      SELECT session_id FROM session_commit_links LIMIT 1
    `;
    expect(row[0]?.session_id).toBe(session);
  });

  test("is idempotent (unique index)", async () => {
    const dev = await createDeveloper("alice@ex.com");
    const start = new Date("2026-04-20T12:00:00Z");
    const end = new Date("2026-04-20T12:30:00Z");
    await createSession(dev, start, end);
    const commit = {
      sha: `f${"0".repeat(39)}`,
      message: "no trailer\n",
      authorEmail: "alice@ex.com",
      committedAt: new Date("2026-04-20T12:15:00Z"),
    };
    await runScanAttribution({ sql: admin, orgId, commits: [commit] });
    const again = await runScanAttribution({ sql: admin, orgId, commits: [commit] });
    expect(again.linked).toBe(0);
    const rows = await admin<{ c: number }[]>`
      SELECT count(*)::int AS c FROM session_commit_links WHERE commit_sha = ${commit.sha}
    `;
    expect(rows[0]?.c).toBe(1);
  });
});

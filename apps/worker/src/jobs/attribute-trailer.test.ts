import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createMigratedDatabase, type TempDatabase } from "@bematist/db/testing";
import postgres from "postgres";
import { extractSessionIds, runTrailerAttribution } from "./attribute-trailer";

let tmp: TempDatabase;
let admin: postgres.Sql;
let orgId = "";
let otherOrgId = "";
let developerId = "";

async function seedSession(
  sql: postgres.Sql,
  sessionIdOpt?: {
    id?: string;
    org?: string;
    dev?: string;
    source?: "claude-code" | "codex" | "cursor";
  },
): Promise<string> {
  const id = sessionIdOpt?.id ?? randomUUID();
  const oid = sessionIdOpt?.org ?? orgId;
  const did = sessionIdOpt?.dev ?? developerId;
  const src = sessionIdOpt?.source ?? "claude-code";
  await sql`
    INSERT INTO sessions (id, org_id, developer_id, source, source_session_id, started_at)
    VALUES (${id}, ${oid}, ${did}, ${src}, ${`src-${id.slice(0, 8)}`}, now())
  `;
  return id;
}

beforeAll(async () => {
  tmp = await createMigratedDatabase();
  admin = postgres(tmp.url, { max: 2, onnotice: () => {}, prepare: false });
  const [org] = await admin<{ id: string }[]>`
    INSERT INTO orgs (slug, name) VALUES ('trailer-org', 'Trailer Org') RETURNING id
  `;
  orgId = org!.id;
  const [org2] = await admin<{ id: string }[]>`
    INSERT INTO orgs (slug, name) VALUES ('trailer-org-2', 'Trailer Org 2') RETURNING id
  `;
  otherOrgId = org2!.id;
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
  await admin`DELETE FROM sessions`;
});

describe("extractSessionIds", () => {
  test("parses a single trailer in a normal commit message", () => {
    const id = randomUUID();
    const msg = `fix the thing\n\nSigned-off-by: someone <x@x>\nBematist-Session: ${id}\n`;
    expect(extractSessionIds(msg)).toEqual([id]);
  });

  test("returns [] when no trailer present", () => {
    expect(extractSessionIds("refactor stuff\n\nbody text\n")).toEqual([]);
  });

  test("dedupes when the same trailer appears twice", () => {
    const id = randomUUID();
    const msg = `commit\n\nBematist-Session: ${id}\nBematist-Session: ${id}\n`;
    expect(extractSessionIds(msg)).toEqual([id]);
  });

  test("rejects non-UUID trailer values", () => {
    const msg = `commit\n\nBematist-Session: not-a-uuid\n`;
    expect(extractSessionIds(msg)).toEqual([]);
  });

  test("ignores trailer in body (only the trailing block counts)", () => {
    const id = randomUUID();
    const msg = `Bematist-Session: ${id}\n\nreal body text\n`;
    // The first line is a valid trailer line but there is body text AFTER it,
    // so it is not the trailing trailer block.
    expect(extractSessionIds(msg)).toEqual([]);
  });

  test("handles CRLF line endings", () => {
    const id = randomUUID();
    const msg = `subject\r\n\r\nBematist-Session: ${id}\r\n`;
    expect(extractSessionIds(msg)).toEqual([id]);
  });

  test("ignores a trailer line missing its value", () => {
    const msg = `commit\n\nBematist-Session:\n`;
    expect(extractSessionIds(msg)).toEqual([]);
  });
});

describe("runTrailerAttribution", () => {
  test("creates a link with signal=trailer and confidence=1.0", async () => {
    const sessionId = await seedSession(admin);
    const sha = `a${"0".repeat(39)}`;
    const res = await runTrailerAttribution({
      sql: admin,
      orgId,
      commits: [
        {
          sha,
          message: `work\n\nBematist-Session: ${sessionId}\n`,
        },
      ],
    });
    expect(res.linked).toBe(1);
    expect(res.matched).toBe(1);
    const rows = await admin<{ session_id: string; signal: string; confidence: string }[]>`
      SELECT session_id, signal, confidence::text FROM session_commit_links WHERE commit_sha = ${sha}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.session_id).toBe(sessionId);
    expect(rows[0]?.signal).toBe("trailer");
    expect(Number(rows[0]?.confidence)).toBeCloseTo(1.0, 3);
  });

  test("skips commits with no trailer", async () => {
    const sessionId = await seedSession(admin);
    void sessionId;
    const res = await runTrailerAttribution({
      sql: admin,
      orgId,
      commits: [{ sha: "b".repeat(40), message: "no trailer here\n" }],
    });
    expect(res.linked).toBe(0);
    expect(res.matched).toBe(0);
  });

  test("dedup across runs via unique index", async () => {
    const sessionId = await seedSession(admin);
    const sha = `c${"0".repeat(39)}`;
    const commit = { sha, message: `x\n\nBematist-Session: ${sessionId}\n` };
    await runTrailerAttribution({ sql: admin, orgId, commits: [commit] });
    const res2 = await runTrailerAttribution({ sql: admin, orgId, commits: [commit] });
    expect(res2.linked).toBe(0);
    const rows = await admin<{ c: number }[]>`
      SELECT count(*)::int AS c FROM session_commit_links WHERE commit_sha = ${sha}
    `;
    expect(rows[0]?.c).toBe(1);
  });

  test("ignores trailer referencing a session in a different org", async () => {
    const otherSession = randomUUID();
    await admin`
      INSERT INTO developers (id, org_id, email) VALUES (${randomUUID()}, ${otherOrgId}, 'x@x')
    `;
    const otherDev = await admin<{ id: string }[]>`
      SELECT id FROM developers WHERE org_id = ${otherOrgId} LIMIT 1
    `;
    await admin`
      INSERT INTO sessions (id, org_id, developer_id, source, source_session_id, started_at)
      VALUES (${otherSession}, ${otherOrgId}, ${otherDev[0]!.id}, 'claude-code', 'src-x', now())
    `;
    const sha = `d${"0".repeat(39)}`;
    const res = await runTrailerAttribution({
      sql: admin,
      orgId,
      commits: [{ sha, message: `x\n\nBematist-Session: ${otherSession}\n` }],
    });
    expect(res.linked).toBe(0);
  });

  test("malformed extra trailer lines don't break parsing", async () => {
    const sessionId = await seedSession(admin);
    const sha = `e${"0".repeat(39)}`;
    const msg = `subject\n\nBematist-Session: ${sessionId}\nBematist-Session: also-bad\n`;
    const res = await runTrailerAttribution({
      sql: admin,
      orgId,
      commits: [{ sha, message: msg }],
    });
    expect(res.linked).toBe(1);
  });
});

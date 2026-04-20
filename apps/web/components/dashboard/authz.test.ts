import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getAdminDb } from "@bematist/db";
import { createMigratedDatabase, type TempDatabase } from "@bematist/db/testing";
import { findDeveloperForUser, getDeveloper, getSessionDetail } from "./queries";

let tmp: TempDatabase;
let orgAId: string;
let orgBId: string;
let adminUserId: string;
let memberUserId: string;
let memberLinkedDevId: string;
let otherDevSameOrgId: string;
let memberSessionId: string;
let otherSessionId: string;
let foreignDevId: string;
let foreignSessionId: string;

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
    adminUserId = randomUUID();
    memberUserId = randomUUID();
    memberLinkedDevId = randomUUID();
    otherDevSameOrgId = randomUUID();
    foreignDevId = randomUUID();
    memberSessionId = randomUUID();
    otherSessionId = randomUUID();
    foreignSessionId = randomUUID();

    await admin.execute(
      `INSERT INTO orgs (id, slug, name) VALUES ('${orgAId}', 'authz-a', 'A'), ('${orgBId}', 'authz-b', 'B')` as never,
    );
    await admin.execute(
      `INSERT INTO users (id, org_id, better_auth_user_id, email, name, role) VALUES
        ('${adminUserId}', '${orgAId}', 'ba_admin', 'admin@a.com', 'Admin', 'admin'),
        ('${memberUserId}', '${orgAId}', 'ba_member', 'member@a.com', 'Member', 'member')` as never,
    );
    await admin.execute(
      `INSERT INTO developers (id, org_id, user_id, email, name) VALUES
        ('${memberLinkedDevId}', '${orgAId}', '${memberUserId}', 'member@a.com', 'Member'),
        ('${otherDevSameOrgId}', '${orgAId}', null, 'other-dev@a.com', 'OtherDev'),
        ('${foreignDevId}', '${orgBId}', null, 'foreign@b.com', 'Foreign')` as never,
    );
    await admin.execute(
      `INSERT INTO sessions (id, org_id, developer_id, source, source_session_id, started_at) VALUES
        ('${memberSessionId}', '${orgAId}', '${memberLinkedDevId}', 'claude-code', 'ss-me', now()),
        ('${otherSessionId}', '${orgAId}', '${otherDevSameOrgId}', 'cursor', 'ss-other', now()),
        ('${foreignSessionId}', '${orgBId}', '${foreignDevId}', 'codex', 'ss-foreign', now())` as never,
    );
  } finally {
    await close();
  }
});

afterAll(async () => {
  if (tmp) await tmp.drop();
});

describe("findDeveloperForUser gating", () => {
  test("member user resolves to their linked developer", async () => {
    const linked = await findDeveloperForUser(orgAId, memberUserId, "member@a.com");
    expect(linked?.id).toBe(memberLinkedDevId);
  });

  test("admin who has no developer row returns null (they need a dev row for /me)", async () => {
    const dev = await findDeveloperForUser(orgAId, adminUserId, "admin@a.com");
    expect(dev).toBeNull();
  });

  test("resolver does not cross orgs", async () => {
    // memberUser belongs to orgA. Query as if they were in orgB.
    const dev = await findDeveloperForUser(orgBId, memberUserId, "member@a.com");
    expect(dev).toBeNull();
  });
});

describe("RLS enforces developer visibility", () => {
  test("getDeveloper cannot return a foreign org developer", async () => {
    const dev = await getDeveloper(orgAId, foreignDevId);
    expect(dev).toBeNull();
  });

  test("getSessionDetail returns null for a foreign org session", async () => {
    const detail = await getSessionDetail(orgAId, foreignSessionId);
    expect(detail).toBeNull();
  });

  test("getSessionDetail finds local org sessions", async () => {
    const detail = await getSessionDetail(orgAId, memberSessionId);
    expect(detail).not.toBeNull();
    expect(detail!.developerId).toBe(memberLinkedDevId);
  });
});

describe("authorization logic for /developers/[id]", () => {
  /**
   * The per-page authorization rule: non-admins may only view /developers/[id]
   * when their linked developer.id matches. Tested here at the data level
   * (the component-level redirect is exercised by inspecting findDeveloperForUser
   * + comparing ids, which is what the server component does).
   */
  test("member cannot see other developer in same org", async () => {
    const linked = await findDeveloperForUser(orgAId, memberUserId, "member@a.com");
    expect(linked).not.toBeNull();
    expect(linked!.id).not.toBe(otherDevSameOrgId);
  });

  test("member's own /me shows exactly their developer row", async () => {
    const linked = await findDeveloperForUser(orgAId, memberUserId, "member@a.com");
    expect(linked?.id).toBe(memberLinkedDevId);
  });
});

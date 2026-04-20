import { afterAll, beforeAll, expect, test } from "bun:test";
import { createMigratedDatabase, type TempDatabase } from "@bematist/db/testing";
import postgres from "postgres";
import { applyAuthMigrations } from "./migrations";

let tmp: TempDatabase;

function appUrl(): string {
  const u = new URL(tmp.url);
  u.username = "app_bematist";
  u.password = "app_bematist_dev";
  return u.toString();
}

beforeAll(async () => {
  tmp = await createMigratedDatabase();
  await applyAuthMigrations({ url: tmp.url });
});

afterAll(async () => {
  if (tmp) await tmp.drop();
});

async function createBetterAuthUser(
  sql: postgres.Sql,
  id: string,
  email: string,
  name = email.split("@")[0],
): Promise<void> {
  await sql`
    INSERT INTO better_auth_user (id, name, email, email_verified)
    VALUES (${id}, ${name ?? "user"}, ${email}, true)
  `;
}

test("first user creates org and becomes admin; tenant-scoped reads require set_config", async () => {
  const admin = postgres(tmp.url, { max: 1, onnotice: () => {} });
  const app = postgres(appUrl(), { max: 2, prepare: false, onnotice: () => {} });

  try {
    await createBetterAuthUser(admin, "ba_alice", "alice@founder.test");

    // Bootstrap flow: the first user picks an org name -> we create the org,
    // then (with app.current_org_id set to that org) insert the users row.
    const [org] = await admin<{ id: string; slug: string }[]>`
      INSERT INTO orgs (slug, name) VALUES ('founder-co', 'Founder Co')
      RETURNING id, slug
    `;
    const orgId = org!.id;

    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx`
        INSERT INTO users (org_id, better_auth_user_id, email, name, role)
        VALUES (${orgId}, 'ba_alice', 'alice@founder.test', 'Alice', 'admin')
      `;
    });

    // Reading back as the same org sees the row.
    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      const rows = await tx<{ role: string }[]>`
        SELECT role FROM users WHERE better_auth_user_id = 'ba_alice'
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]!.role).toBe("admin");
    });
  } finally {
    await app.end({ timeout: 5 });
    await admin.end({ timeout: 5 });
  }
});

test("second user via invite joins existing org as member", async () => {
  const admin = postgres(tmp.url, { max: 1, onnotice: () => {} });
  const app = postgres(appUrl(), { max: 2, prepare: false, onnotice: () => {} });

  try {
    await createBetterAuthUser(admin, "ba_admin2", "owner@team.test");
    const [org] = await admin<{ id: string }[]>`
      INSERT INTO orgs (slug, name) VALUES ('team', 'Team') RETURNING id
    `;
    const orgId = org!.id;

    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx`
        INSERT INTO users (org_id, better_auth_user_id, email, role)
        VALUES (${orgId}, 'ba_admin2', 'owner@team.test', 'admin')
      `;
    });

    // Admin mints an invite token for teammate; teammate signs in and lands
    // on /post-auth/accept-invite which, having verified the token, inserts
    // the users row scoped to the invite's orgId with role=member.
    await createBetterAuthUser(admin, "ba_teammate", "dev@team.test");
    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx`
        INSERT INTO users (org_id, better_auth_user_id, email, role)
        VALUES (${orgId}, 'ba_teammate', 'dev@team.test', 'member')
      `;
    });

    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      const rows = await tx<{ email: string; role: string }[]>`
        SELECT email, role FROM users ORDER BY email ASC
      `;
      expect(rows.length).toBe(2);
      expect(rows[0]!.email).toBe("dev@team.test");
      expect(rows[0]!.role).toBe("member");
      expect(rows[1]!.email).toBe("owner@team.test");
      expect(rows[1]!.role).toBe("admin");
    });
  } finally {
    await app.end({ timeout: 5 });
    await admin.end({ timeout: 5 });
  }
});

test("cross-org RLS probe: scoped to org B returns zero users from org A", async () => {
  const admin = postgres(tmp.url, { max: 1, onnotice: () => {} });
  const app = postgres(appUrl(), { max: 2, prepare: false, onnotice: () => {} });

  try {
    const [orgA] = await admin<{ id: string }[]>`
      INSERT INTO orgs (slug, name) VALUES ('rls-a', 'RLS A') RETURNING id
    `;
    const [orgB] = await admin<{ id: string }[]>`
      INSERT INTO orgs (slug, name) VALUES ('rls-b', 'RLS B') RETURNING id
    `;
    const orgAId = orgA!.id;
    const orgBId = orgB!.id;

    await createBetterAuthUser(admin, "ba_rls_a", "a@rls.test");
    await createBetterAuthUser(admin, "ba_rls_b", "b@rls.test");

    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgAId}, true)`;
      await tx`
        INSERT INTO users (org_id, better_auth_user_id, email, role)
        VALUES (${orgAId}, 'ba_rls_a', 'a@rls.test', 'admin')
      `;
    });
    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgBId}, true)`;
      await tx`
        INSERT INTO users (org_id, better_auth_user_id, email, role)
        VALUES (${orgBId}, 'ba_rls_b', 'b@rls.test', 'admin')
      `;
    });

    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgBId}, true)`;
      const rows = await tx<{ email: string }[]>`
        SELECT email FROM users WHERE email = 'a@rls.test'
      `;
      expect(rows.length).toBe(0);
    });

    // Also confirm org B sees exactly its own row.
    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgBId}, true)`;
      const rows = await tx<{ email: string }[]>`SELECT email FROM users ORDER BY email`;
      expect(rows.length).toBe(1);
      expect(rows[0]!.email).toBe("b@rls.test");
    });
  } finally {
    await app.end({ timeout: 5 });
    await admin.end({ timeout: 5 });
  }
});

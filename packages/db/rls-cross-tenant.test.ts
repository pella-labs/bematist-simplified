import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { createMigratedDatabase, type TempDatabase } from "./testing";

let tmp: TempDatabase;
let orgA = "";
let orgB = "";
let devA = "";

beforeAll(async () => {
  tmp = await createMigratedDatabase();

  // Seed two orgs + a developer under org A via an admin connection.
  const admin = postgres(tmp.url, { max: 1, onnotice: () => {} });
  try {
    const [rowA] = await admin<{ id: string }[]>`
      INSERT INTO orgs (slug, name) VALUES ('org-a', 'Org A') RETURNING id
    `;
    const [rowB] = await admin<{ id: string }[]>`
      INSERT INTO orgs (slug, name) VALUES ('org-b', 'Org B') RETURNING id
    `;
    orgA = rowA!.id;
    orgB = rowB!.id;
    const [dev] = await admin<{ id: string }[]>`
      INSERT INTO developers (org_id, email, name)
      VALUES (${orgA}, 'a@test', 'Alice') RETURNING id
    `;
    devA = dev!.id;
  } finally {
    await admin.end({ timeout: 5 });
  }
});

afterAll(async () => {
  if (tmp) await tmp.drop();
});

// The application role (app_bematist) is NOBYPASSRLS. We connect as that role
// for these tests so RLS actually applies. The default bematist superuser
// bypasses RLS and would false-pass.
function appUrl(): string {
  const u = new URL(tmp.url);
  u.username = "app_bematist";
  u.password = "app_bematist_dev";
  return u.toString();
}

test("reading as org B returns zero rows that belong to org A", async () => {
  const sql = postgres(appUrl(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgB}, true)`;
      const rows = await tx<{ id: string }[]>`SELECT id FROM developers`;
      expect(rows.length).toBe(0);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("reading as org A returns its own developer row", async () => {
  const sql = postgres(appUrl(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgA}, true)`;
      const rows = await tx<{ id: string }[]>`SELECT id FROM developers`;
      expect(rows.length).toBe(1);
      expect(rows[0]!.id).toBe(devA);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("inserting into org A while scoped to org B is blocked by RLS", async () => {
  const sql = postgres(appUrl(), { max: 1, prepare: false, onnotice: () => {} });
  let threw = false;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgB}, true)`;
      await tx`
        INSERT INTO developers (org_id, email, name)
        VALUES (${orgA}, 'intruder@test', 'Mallory')
      `;
    });
  } catch (err) {
    threw = true;
    expect(String(err)).toMatch(/row-level security|row level security|violates/i);
  } finally {
    await sql.end({ timeout: 5 });
  }
  expect(threw).toBe(true);
});

test("app role has no access without app.current_org_id set", async () => {
  const sql = postgres(appUrl(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`SELECT id FROM developers`;
      expect(rows.length).toBe(0);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
});

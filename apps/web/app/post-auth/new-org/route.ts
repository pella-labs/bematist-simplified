import { orgs, users } from "@bematist/db/schema";
import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { NextResponse } from "next/server";
import { adminConnection, getOptionalSession, withOrgScope } from "@/lib/session";

export async function GET(): Promise<Response> {
  const session = await getOptionalSession();
  if (!session) {
    return NextResponse.redirect(new URL("/auth/sign-in", baseURL()));
  }
  if (session.internal) {
    return NextResponse.redirect(new URL("/", baseURL()));
  }
  const email = session.betterAuthUser.email;
  return new Response(renderForm({ email, error: null, value: suggestOrgName(email) }), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function POST(req: Request): Promise<Response> {
  const session = await getOptionalSession();
  if (!session) {
    return NextResponse.redirect(new URL("/auth/sign-in", baseURL()), 303);
  }
  if (session.internal) {
    return NextResponse.redirect(new URL("/", baseURL()), 303);
  }

  const form = await req.formData();
  const rawName = String(form.get("org_name") ?? "").trim();
  const validation = validateOrgName(rawName);
  if (!validation.ok) {
    return new Response(
      renderForm({
        email: session.betterAuthUser.email,
        error: validation.reason,
        value: rawName,
      }),
      { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  const slug = await allocateSlug(validation.name);
  const { sql, close } = adminConnection();
  let createdOrgId: string;
  try {
    const adminDb = drizzle(sql);
    const inserted = await adminDb
      .insert(orgs)
      .values({ slug, name: validation.name })
      .returning({ id: orgs.id });
    const row = inserted[0];
    if (!row) {
      throw new Error("org insert returned no row");
    }
    createdOrgId = row.id;
  } finally {
    await close();
  }

  await withOrgScope(createdOrgId, async (tx) => {
    await tx.insert(users).values({
      orgId: createdOrgId,
      betterAuthUserId: session.betterAuthUser.id,
      email: session.betterAuthUser.email,
      name: session.betterAuthUser.name,
      role: "admin",
    });
  });

  return NextResponse.redirect(new URL("/", baseURL()), 303);
}

function baseURL(): string {
  return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
}

function validateOrgName(name: string): { ok: true; name: string } | { ok: false; reason: string } {
  if (name.length === 0) return { ok: false, reason: "Organization name is required." };
  if (name.length > 80) return { ok: false, reason: "Organization name is too long (max 80)." };
  return { ok: true, name };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, 40);
}

function suggestOrgName(email: string): string {
  const domain = email.split("@")[1] ?? "";
  const root = domain.split(".")[0] ?? "";
  return root ? root.charAt(0).toUpperCase() + root.slice(1) : "";
}

async function allocateSlug(name: string): Promise<string> {
  const base = slugify(name) || "team";
  const { sql, close } = adminConnection();
  try {
    const db = drizzle(sql);
    const existing = await db
      .select({ slug: orgs.slug })
      .from(orgs)
      .where(dsql`${orgs.slug} = ${base} OR ${orgs.slug} LIKE ${`${base}-%`}`);
    const taken = new Set(existing.map((r) => r.slug));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new Error("could not allocate org slug");
  } finally {
    await close();
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderForm(opts: { email: string; error: string | null; value: string }): string {
  const errBlock = opts.error
    ? `<p class="mk-auth-err" role="alert">${escapeHtml(opts.error)}</p>`
    : "";
  const val = escapeHtml(opts.value);
  const email = escapeHtml(opts.email);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Name your team — Bematist</title>
<style>
  body { margin: 0; background: #0a0b0d; color: #ede8de; font-family: Inter, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 48px 24px; }
  .card { width: 100%; max-width: 480px; background: #111316; border: 1px solid rgba(237, 232, 222, 0.12); padding: 44px 40px; display: flex; flex-direction: column; gap: 16px; }
  .label { font-family: "JetBrains Mono", monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; color: #6e8a6f; }
  h1 { font-size: 28px; letter-spacing: -0.03em; margin: 0; font-weight: 500; }
  p { color: rgba(237, 232, 222, 0.6); font-size: 14px; line-height: 1.6; margin: 0; }
  input { height: 44px; padding: 0 14px; background: #0a0b0d; color: #ede8de; border: 1px solid rgba(237, 232, 222, 0.12); font-size: 14px; outline: none; width: 100%; box-sizing: border-box; }
  input:focus { border-color: #6e8a6f; }
  button { height: 44px; padding: 0 20px; background: #ede8de; color: #0a0b0d; font-family: "JetBrains Mono", monospace; font-size: 13px; letter-spacing: 0.02em; border: none; cursor: pointer; transition: background 0.18s; }
  button:hover { background: #6e8a6f; }
  .mk-auth-err { color: #d66a6a; font-size: 13px; margin: 0; }
  small { color: rgba(237, 232, 222, 0.3); font-size: 11px; }
</style>
</head>
<body>
  <form class="card" method="POST" action="/post-auth/new-org">
    <span class="label">Welcome</span>
    <h1>Name your team</h1>
    <p>You're signed in as <strong>${email}</strong>. Pick a name for your organization — this is the tenant every teammate you invite will join.</p>
    ${errBlock}
    <input type="text" name="org_name" value="${val}" placeholder="Acme Co" autofocus required maxlength="80" />
    <button type="submit">Create organization</button>
    <small>You can rename it later. Slug will be derived automatically.</small>
  </form>
</body>
</html>`;
}

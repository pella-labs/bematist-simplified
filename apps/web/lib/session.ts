import "server-only";
import { getAuth } from "@bematist/auth";
import { orgs, users } from "@bematist/db/schema";
import { eq, sql as sqlTag } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import postgres, { type Sql } from "postgres";

export type SessionRole = "admin" | "member";

export interface SessionContext {
  user: { id: string; email: string; name: string | null };
  org: { id: string; slug: string; name: string };
  role: SessionRole;
}

export interface RequireSessionOptions {
  /**
   * Optional path to redirect to when the authenticated Better-Auth identity
   * has no internal `users` row yet. Defaults to `/post-auth/new-org`.
   */
  postAuthRedirect?: string;
}

// Web routes talk directly to Postgres via `postgres` + Drizzle — the full
// @bematist/db index pulls the migration loader which Turbopack can't
// statically resolve. Table definitions still come from @bematist/db/schema.
//
// adminConnection() is used for the one cross-tenant query we need: resolve
// `better_auth_user_id -> (users, orgs)`. That lookup happens before we
// know the org, so it cannot go through an `app.current_org_id`-scoped
// transaction. Prefer `ADMIN_DATABASE_URL` (BYPASSRLS role) when set;
// otherwise fall back to DATABASE_URL. In prod, ADMIN_DATABASE_URL should
// point at a role that can SELECT users cross-tenant.
function adminConnection(): { sql: Sql; close: () => Promise<void> } {
  const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 2, prepare: false });
  return { sql, close: () => sql.end({ timeout: 5 }) };
}

async function withOrgScope<T>(
  orgId: string,
  fn: (db: ReturnType<typeof drizzle>) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-fA-F-]{36}$/.test(orgId)) throw new Error(`invalid orgId: ${orgId}`);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: 2, prepare: false });
  const db = drizzle(client);
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sqlTag`SELECT set_config('app.current_org_id', ${orgId}, true)`);
      return fn(tx as unknown as ReturnType<typeof drizzle>);
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

export { adminConnection, withOrgScope };

/**
 * Resolve the signed-in user + org + role for a server component.
 *
 * - Reads the Better-Auth session from request cookies.
 * - If unauthenticated: redirects to /auth/sign-in.
 * - If authenticated but no internal users row exists yet: redirects to the
 *   post-auth onboarding (pick org or accept invite).
 * - Otherwise returns a tenant-scoped context. Downstream callers MUST use
 *   withOrgScope(org.id, ...) for any subsequent query so RLS kicks in.
 */
export async function requireSession(options: RequireSessionOptions = {}): Promise<SessionContext> {
  const auth = getAuth();
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session?.user) {
    redirect("/auth/sign-in");
  }

  const betterAuthUser = session.user;
  const { sql, close } = adminConnection();
  const db = drizzle(sql);
  try {
    const row = await db
      .select({
        userId: users.id,
        userEmail: users.email,
        userName: users.name,
        role: users.role,
        orgId: orgs.id,
        orgSlug: orgs.slug,
        orgName: orgs.name,
      })
      .from(users)
      .innerJoin(orgs, eq(users.orgId, orgs.id))
      .where(eq(users.betterAuthUserId, betterAuthUser.id))
      .limit(1);

    const first = row[0];
    if (!first) {
      redirect(options.postAuthRedirect ?? "/post-auth/new-org");
    }

    return {
      user: {
        id: first.userId,
        email: first.userEmail,
        name: first.userName,
      },
      org: {
        id: first.orgId,
        slug: first.orgSlug,
        name: first.orgName,
      },
      role: first.role as SessionRole,
    };
  } finally {
    await close();
  }
}

/**
 * Non-redirecting variant — useful in post-auth routes that need to detect
 * the "no users row" state and prompt for org bootstrap.
 */
export async function getOptionalSession(): Promise<{
  betterAuthUser: { id: string; email: string; name: string };
  internal: SessionContext | null;
} | null> {
  const auth = getAuth();
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session?.user) return null;
  const u = session.user;

  const { sql, close } = adminConnection();
  const db = drizzle(sql);
  try {
    const row = await db
      .select({
        userId: users.id,
        userEmail: users.email,
        userName: users.name,
        role: users.role,
        orgId: orgs.id,
        orgSlug: orgs.slug,
        orgName: orgs.name,
      })
      .from(users)
      .innerJoin(orgs, eq(users.orgId, orgs.id))
      .where(eq(users.betterAuthUserId, u.id))
      .limit(1);

    const first = row[0];
    if (!first) {
      return {
        betterAuthUser: { id: u.id, email: u.email, name: u.name ?? u.email },
        internal: null,
      };
    }
    return {
      betterAuthUser: { id: u.id, email: u.email, name: u.name ?? u.email },
      internal: {
        user: { id: first.userId, email: first.userEmail, name: first.userName },
        org: { id: first.orgId, slug: first.orgSlug, name: first.orgName },
        role: first.role as SessionRole,
      },
    };
  } finally {
    await close();
  }
}

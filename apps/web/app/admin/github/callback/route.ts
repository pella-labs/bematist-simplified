import { githubInstallations } from "@bematist/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { NextResponse } from "next/server";
// Lazy runtime import for `@/lib/session` keeps Better-Auth, `server-only`,
// and a live Postgres client out of this module's top-level graph so the
// route can be unit-tested under Bun via the CallbackDeps seam.
import type { SessionContext, withOrgScope as WithOrgScopeT } from "@/lib/session";
import {
  type BackfillDeps,
  backfillReposForInstallation as defaultBackfill,
} from "../../../../lib/githubRepos";

function baseURL(): string {
  return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
}

function redirectBack(params: URLSearchParams): Response {
  const url = new URL(`/admin/github?${params.toString()}`, baseURL());
  return NextResponse.redirect(url, 303);
}

export interface CallbackDeps {
  requireSession: () => Promise<SessionContext>;
  /** Look up any existing installation row by `installation_id`. */
  lookupInstallationOwner: (
    installationId: number,
  ) => Promise<{ orgId: string; status: string } | null>;
  withOrgScope: typeof WithOrgScopeT;
  backfill: (
    input: { orgId: string; installationId: number },
    deps?: BackfillDeps,
  ) => Promise<{ ok: boolean; reason?: string; count?: number }>;
  backfillDeps?: BackfillDeps;
}

async function defaultLookupInstallationOwner(
  installationId: number,
): Promise<{ orgId: string; status: string } | null> {
  const { adminConnection } = await import("@/lib/session");
  const { sql, close } = adminConnection();
  try {
    const adminDb = drizzle(sql);
    const rows = await adminDb
      .select({ orgId: githubInstallations.orgId, status: githubInstallations.status })
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1);
    return rows[0] ?? null;
  } finally {
    await close();
  }
}

async function productionDeps(): Promise<CallbackDeps> {
  const session = await import("@/lib/session");
  return {
    requireSession: session.requireSession,
    lookupInstallationOwner: defaultLookupInstallationOwner,
    withOrgScope: session.withOrgScope,
    backfill: defaultBackfill,
  };
}

export async function handleCallback(req: Request, deps: CallbackDeps): Promise<Response> {
  const session = await deps.requireSession();
  if (session.role !== "admin") {
    return NextResponse.redirect(new URL("/?forbidden=admin-only", baseURL()), 303);
  }

  const url = new URL(req.url);
  const installationIdStr = url.searchParams.get("installation_id");
  const setupAction = url.searchParams.get("setup_action");

  if (!installationIdStr) {
    const p = new URLSearchParams({ status: "err", message: "Missing installation_id." });
    return redirectBack(p);
  }

  const installationId = Number(installationIdStr);
  if (!Number.isFinite(installationId) || installationId <= 0) {
    const p = new URLSearchParams({ status: "err", message: "Invalid installation_id." });
    return redirectBack(p);
  }

  // Claim the installation for this org. Another org claiming the same
  // installation_id is a conflict — we refuse with a message rather than
  // silently moving ownership.
  const existing = await deps.lookupInstallationOwner(installationId);
  if (existing && existing.orgId !== session.org.id) {
    const p = new URLSearchParams({
      status: "err",
      message: "Installation already linked to another organisation.",
    });
    return redirectBack(p);
  }

  await deps.withOrgScope(session.org.id, async (tx) => {
    await tx
      .insert(githubInstallations)
      .values({
        orgId: session.org.id,
        installationId,
        status: "active",
      })
      .onConflictDoUpdate({
        target: githubInstallations.installationId,
        set: { status: "active" },
      });
  });

  // Best-effort repo backfill. The installation.created webhook is the
  // primary path; this closes the gap where the webhook is delayed,
  // misconfigured, or never fires on a manual install. Any error is logged
  // and swallowed — the redirect must succeed regardless.
  try {
    await deps.backfill({ orgId: session.org.id, installationId }, deps.backfillDeps);
  } catch (err) {
    console.error("[admin/github/callback] repo backfill failed", err);
  }

  const p = new URLSearchParams({
    status: "ok",
    message:
      setupAction === "update"
        ? "Installation updated. Repository changes will sync via webhook."
        : "Installation connected. Push a commit to see data flow in.",
  });
  return redirectBack(p);
}

export async function GET(req: Request): Promise<Response> {
  return handleCallback(req, await productionDeps());
}

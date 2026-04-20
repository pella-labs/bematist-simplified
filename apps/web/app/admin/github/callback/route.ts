import { githubInstallations } from "@bematist/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { NextResponse } from "next/server";
import { adminConnection, requireSession, withOrgScope } from "@/lib/session";

function baseURL(): string {
  return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
}

function redirectBack(params: URLSearchParams): Response {
  const url = new URL(`/admin/github?${params.toString()}`, baseURL());
  return NextResponse.redirect(url, 303);
}

export async function GET(req: Request): Promise<Response> {
  const session = await requireSession();
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
  const { sql, close } = adminConnection();
  try {
    const adminDb = drizzle(sql);
    const existing = await adminDb
      .select({ orgId: githubInstallations.orgId, status: githubInstallations.status })
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1);

    const row = existing[0];
    if (row && row.orgId !== session.org.id) {
      const p = new URLSearchParams({
        status: "err",
        message: "Installation already linked to another organisation.",
      });
      return redirectBack(p);
    }
  } finally {
    await close();
  }

  await withOrgScope(session.org.id, async (tx) => {
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

  const p = new URLSearchParams({
    status: "ok",
    message:
      setupAction === "update"
        ? "Installation updated. Repository changes will sync via webhook."
        : "Installation connected. Push a commit to see data flow in.",
  });
  return redirectBack(p);
}

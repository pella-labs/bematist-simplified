import { verifyInvite } from "@bematist/auth";
import { orgs, users } from "@bematist/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { NextResponse } from "next/server";
import { adminConnection, getOptionalSession, withOrgScope } from "@/lib/session";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return htmlError("Missing invite token.", 400);
  }

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    return htmlError("Server misconfigured: BETTER_AUTH_SECRET is not set.", 500);
  }

  const verify = verifyInvite(secret, token);
  if (!verify.ok) {
    const msg =
      verify.reason === "expired"
        ? "This invite link has expired. Ask your admin to send a new one."
        : "Invalid invite link.";
    return htmlError(msg, 400);
  }
  const payload = verify.payload;

  const session = await getOptionalSession();
  if (!session) {
    return NextResponse.redirect(
      new URL(`/auth/sign-in?invite=${encodeURIComponent(token)}`, baseURL()),
    );
  }

  // If the signed-in email doesn't match the invite, refuse — the invite is
  // addressed to a specific teammate.
  if (session.betterAuthUser.email.toLowerCase() !== payload.email.toLowerCase()) {
    return htmlError(
      `This invite was sent to ${payload.email}, but you are signed in as ${session.betterAuthUser.email}.`,
      403,
    );
  }

  if (session.internal) {
    // Already a member somewhere. For v1 we don't support multi-org per
    // identity, so no-op redirect to dashboard.
    return NextResponse.redirect(new URL("/", baseURL()));
  }

  const { sql, close } = adminConnection();
  let orgName = "";
  try {
    const db = drizzle(sql);
    const orgRow = await db
      .select({ id: orgs.id, name: orgs.name })
      .from(orgs)
      .where(eq(orgs.id, payload.orgId))
      .limit(1);
    if (orgRow.length === 0) {
      return htmlError("The organization for this invite no longer exists.", 410);
    }
    orgName = orgRow[0]!.name;
  } finally {
    await close();
  }

  await withOrgScope(payload.orgId, async (tx) => {
    await tx
      .insert(users)
      .values({
        orgId: payload.orgId,
        betterAuthUserId: session.betterAuthUser.id,
        email: session.betterAuthUser.email,
        name: session.betterAuthUser.name,
        role: payload.role,
      })
      .onConflictDoNothing({
        target: [users.orgId, users.email],
      });
  });

  return NextResponse.redirect(new URL(`/?welcome=${encodeURIComponent(orgName)}`, baseURL()), 303);
}

function baseURL(): string {
  return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
}

function htmlError(message: string, status: number): Response {
  const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Invite error — Bematist</title>
<style>body{margin:0;background:#0a0b0d;color:#ede8de;font-family:Inter,-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:48px 24px}
.card{max-width:480px;padding:40px;background:#111316;border:1px solid rgba(237,232,222,0.12)}
h1{font-size:24px;letter-spacing:-0.03em;margin:0 0 12px}
p{color:rgba(237,232,222,0.7);line-height:1.6;margin:0 0 20px}
a{color:#6e8a6f;text-decoration:none;font-family:"JetBrains Mono",monospace;font-size:12px;letter-spacing:0.04em;text-transform:uppercase}
a:hover{color:#ede8de}</style></head>
<body><div class="card"><h1>Cannot accept this invite</h1><p>${safe}</p><a href="/">Return home</a></div></body></html>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

import { createHmac, timingSafeEqual } from "node:crypto";

// HMAC-signed invite tokens. No invites table exists (WS-1 shipped without
// one); a future dedicated workstream can add persistent/revocable invites.
// Until then: admin mints a token, sends the link to a teammate, teammate
// lands on /post-auth/accept-invite?token=<...> after GitHub OAuth.
//
// Token layout: base64url(JSON payload) + "." + base64url(hmacSha256).
// Payload: { orgId, email, role, exp } — exp is unix seconds.

export interface InvitePayload {
  orgId: string;
  email: string;
  role: "member";
  exp: number;
}

export interface InviteSignOptions {
  orgId: string;
  email: string;
  ttlSeconds?: number;
  now?: () => number;
}

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function signInvite(secret: string, opts: InviteSignOptions): string {
  if (!secret) throw new Error("invite secret required");
  const now = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
  const payload: InvitePayload = {
    orgId: opts.orgId,
    email: opts.email.toLowerCase(),
    role: "member",
    exp: now + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = createHmac("sha256", secret).update(payloadB64).digest();
  return `${payloadB64}.${b64urlEncode(mac)}`;
}

export type VerifyInviteResult =
  | { ok: true; payload: InvitePayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyInvite(
  secret: string,
  token: string,
  opts: { now?: () => number } = {},
): VerifyInviteResult {
  if (!secret) throw new Error("invite secret required");
  if (!token || typeof token !== "string") return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadB64, macB64] = parts as [string, string];
  const expected = createHmac("sha256", secret).update(payloadB64).digest();
  let provided: Buffer;
  try {
    provided = b64urlDecode(macB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (provided.length !== expected.length) return { ok: false, reason: "bad_signature" };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: "bad_signature" };

  let payload: InvitePayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as InvitePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload.orgId !== "string" ||
    typeof payload.email !== "string" ||
    payload.role !== "member" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  const now = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
  if (payload.exp < now) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

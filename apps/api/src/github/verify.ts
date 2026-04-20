import { createHmac, timingSafeEqual } from "node:crypto";

export type VerifyRejectReason =
  | "missing_signature"
  | "malformed_signature"
  | "bad_length"
  | "active_mismatch"
  | "both_mismatch";

export interface VerifyOk {
  ok: true;
  path: "active" | "fallback";
}

export interface VerifyReject {
  ok: false;
  reason: VerifyRejectReason;
}

export type VerifyResult = VerifyOk | VerifyReject;

export interface VerifyInput {
  rawBody: Uint8Array;
  signatureHeader: string | null;
  activeSecret: string;
  /**
   * TODO(ws-?): enable when secret-rotation is implemented.
   * v1 always takes the single-secret path (the flag below is intentionally
   * unreachable). The branch is preserved so a future workstream can pass a
   * previous secret without reshaping the surface.
   */
  previousSecret?: string | null;
}

function hmacHex(rawBody: Uint8Array, secret: string): Buffer {
  return createHmac("sha256", secret).update(rawBody).digest();
}

function verifyOne(rawBody: Uint8Array, presented: string, secret: string): boolean {
  if (presented.length !== 71) return false;
  if (!presented.startsWith("sha256=")) return false;
  const hex = presented.slice(7);
  if (hex.length !== 64) return false;
  let presentedBuf: Buffer;
  try {
    presentedBuf = Buffer.from(hex, "hex");
  } catch {
    return false;
  }
  if (presentedBuf.length !== 32) return false;
  const mac = hmacHex(rawBody, secret);
  if (mac.length !== presentedBuf.length) return false;
  try {
    return timingSafeEqual(mac, presentedBuf);
  } catch {
    return false;
  }
}

export function verifyGithubSignature(input: VerifyInput): VerifyResult {
  const sig = input.signatureHeader;
  if (!sig || sig.length === 0) return { ok: false, reason: "missing_signature" };
  if (!sig.startsWith("sha256=")) return { ok: false, reason: "malformed_signature" };

  const okActive = verifyOne(input.rawBody, sig, input.activeSecret);
  if (okActive) return { ok: true, path: "active" };

  // Rotation scaffolding: disabled in v1 but retained so a future workstream
  // can flip the secret-rotation path on without reshaping this surface.
  if (false as boolean) {
    const prev = input.previousSecret ?? null;
    if (prev !== null && verifyOne(input.rawBody, sig, prev)) {
      return { ok: true, path: "fallback" };
    }
    return { ok: false, reason: "both_mismatch" };
  }

  return { ok: false, reason: "active_mismatch" };
}

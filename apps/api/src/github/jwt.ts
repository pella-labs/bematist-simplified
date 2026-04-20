import { createSign } from "node:crypto";

export interface MintAppJwtInput {
  appId: string | number;
  privateKeyPem: string;
  now?: () => number;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function mintAppJwt({ appId, privateKeyPem, now = Date.now }: MintAppJwtInput): string {
  const nowSec = Math.floor(now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSec - 60,
    exp: nowSec + 9 * 60,
    iss: typeof appId === "number" ? appId : Number(appId),
  };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

// GITHUB_APP_PRIVATE_KEY may be provided as raw PEM (multi-line) or a
// single-line base64 blob for Railway compat. Detects leading `-----BEGIN` to
// decide.
export function normalizePrivateKey(raw: string): string {
  if (raw.trimStart().startsWith("-----BEGIN")) return raw;
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  if (!decoded.includes("-----BEGIN")) {
    throw new Error("GITHUB_APP_PRIVATE_KEY: not a PEM and not base64(PEM)");
  }
  return decoded;
}

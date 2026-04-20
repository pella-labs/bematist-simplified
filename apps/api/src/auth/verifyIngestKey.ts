import { createHash, timingSafeEqual } from "node:crypto";
import type { Sql } from "postgres";
import { UnauthorizedError } from "../errors";

export interface VerifiedIngestKey {
  orgId: string;
  developerId: string;
  keyId: string;
}

interface ParsedBearer {
  orgId: string;
  keyId: string;
  secret: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_ID_RE = /^[A-Za-z0-9]{8,64}$/;

function parseBearer(authHeader: string | null): ParsedBearer {
  if (!authHeader) throw new UnauthorizedError("missing authorization header");
  const match = authHeader.match(/^Bearer\s+(\S+)$/);
  if (!match) throw new UnauthorizedError("malformed authorization header");
  const token = match[1] as string;
  const parts = token.split("_");
  if (parts.length !== 4) throw new UnauthorizedError("malformed ingest key");
  const [prefix, orgId, keyId, secret] = parts as [string, string, string, string];
  if (prefix !== "bm") throw new UnauthorizedError("malformed ingest key");
  if (!UUID_RE.test(orgId)) throw new UnauthorizedError("malformed ingest key");
  if (!KEY_ID_RE.test(keyId)) throw new UnauthorizedError("malformed ingest key");
  if (secret.length < 16) throw new UnauthorizedError("malformed ingest key");
  return { orgId, keyId, secret };
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function constantTimeEqualsHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    const filler = Buffer.alloc(a.length || 1);
    timingSafeEqual(filler, filler);
    return false;
  }
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return timingSafeEqual(ba, bb);
}

export async function verifyIngestKey(
  sql: Sql,
  authHeader: string | null,
): Promise<VerifiedIngestKey> {
  const { orgId, keyId, secret } = parseBearer(authHeader);
  const id = `bm_${orgId}_${keyId}`;
  const presentedSha = sha256Hex(secret);

  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    return tx<{ developer_id: string; key_sha256: string; revoked_at: Date | null }[]>`
      SELECT developer_id, key_sha256, revoked_at
      FROM ingest_keys
      WHERE id = ${id} AND org_id = ${orgId}
      LIMIT 1
    `;
  });

  const dummy = "0".repeat(64);
  if (rows.length === 0) {
    constantTimeEqualsHex(presentedSha, dummy);
    throw new UnauthorizedError("invalid ingest key");
  }
  const row = rows[0] as { developer_id: string; key_sha256: string; revoked_at: Date | null };
  const ok = constantTimeEqualsHex(presentedSha, row.key_sha256);
  if (!ok) throw new UnauthorizedError("invalid ingest key");
  if (row.revoked_at !== null) throw new UnauthorizedError("ingest key revoked");

  return { orgId, developerId: row.developer_id, keyId };
}

export const __test__ = { parseBearer, sha256Hex };

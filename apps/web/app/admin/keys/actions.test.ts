import { describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
// Relative import: the api parser is the source of truth for the token shape.
// We test that what the admin action builds parses cleanly on the api side.
import { parseBearer, sha256Hex } from "../../../../api/src/auth/verifyIngestKey";
import { sha256Hex as webSha256Hex } from "../../../lib/keyHash";

/**
 * This test file does NOT invoke `mintIngestKeyForDeveloper` directly because
 * it's a Next.js server action with heavy side-effect imports (auth session,
 * drizzle, revalidatePath). Instead it mirrors the key-building logic and
 * asserts that the api parser accepts the output — i.e. the two halves agree
 * on the wire format.
 */
function buildKeyMaterial(orgId: string) {
  const suffix = randomBytes(6).toString("hex");
  const id = `bm_${orgId}_${suffix}`;
  const secret = randomBytes(32).toString("hex");
  const plaintext = `${id}_${secret}`;
  const keySha256 = webSha256Hex(secret);
  return { id, plaintext, secret, suffix, keySha256 };
}

describe("admin mint-key ↔ api parser compatibility", () => {
  test("plaintext parses via parseBearer and yields matching orgId + keyId", () => {
    const orgId = randomUUID();
    const { id, plaintext, suffix, secret } = buildKeyMaterial(orgId);
    const parsed = parseBearer(`Bearer ${plaintext}`);
    expect(parsed.orgId).toBe(orgId);
    expect(parsed.keyId).toBe(suffix);
    expect(parsed.secret).toBe(secret);
    expect(id).toBe(`bm_${orgId}_${suffix}`);
  });

  test("key_sha256 column stores sha256(secret) only, matching api verification path", () => {
    const orgId = randomUUID();
    const { plaintext, keySha256 } = buildKeyMaterial(orgId);
    const { secret: parsedSecret } = parseBearer(`Bearer ${plaintext}`);
    expect(keySha256).toBe(sha256Hex(parsedSecret));
    expect(keySha256).not.toBe(sha256Hex(plaintext));
  });

  test("db primary key id equals `bm_<fullOrgId>_<suffix>` (no truncation, dashes preserved)", () => {
    const orgId = randomUUID();
    const { id, suffix } = buildKeyMaterial(orgId);
    expect(id).toBe(`bm_${orgId}_${suffix}`);
    expect(id.split("_").length).toBe(3);
    // The id stores the full UUID including dashes.
    expect(id).toContain(orgId);
  });

  test("plaintext uses underscore (not dot) as the separator between id and secret", () => {
    const orgId = randomUUID();
    const { plaintext, id, secret } = buildKeyMaterial(orgId);
    expect(plaintext).toBe(`${id}_${secret}`);
    expect(plaintext.includes(".")).toBe(false);
    // Exactly 4 underscore-separated parts when split.
    expect(plaintext.split("_").length).toBe(4);
  });

  test("secret is at least 16 chars long (assertion in mint action)", () => {
    const orgId = randomUUID();
    const { secret } = buildKeyMaterial(orgId);
    expect(secret.length).toBeGreaterThanOrEqual(16);
  });
});

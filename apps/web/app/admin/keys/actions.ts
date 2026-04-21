"use server";

import { randomBytes } from "node:crypto";
import { developers, ingestKeys } from "@bematist/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { sha256Hex } from "@/lib/keyHash";
import { requireSession, withOrgScope } from "@/lib/session";

function randomSecret(): string {
  // Hex-only: the api parser splits the token on `_`, so the secret must not
  // contain `_`. Alphanumeric hex sidesteps the whole base64url ambiguity.
  return randomBytes(32).toString("hex");
}

function randomIdSuffix(): string {
  // 12 hex chars — satisfies KEY_ID_RE /^[A-Za-z0-9]{8,64}$/ in the api parser.
  return randomBytes(6).toString("hex");
}

export interface MintKeyResult {
  ok: true;
  keyId: string;
  plaintext: string;
  developerId: string;
}

export interface MintKeyError {
  ok: false;
  error: string;
}

export async function mintIngestKeyForDeveloper(
  developerEmail: string,
  developerName: string,
): Promise<MintKeyResult | MintKeyError> {
  const session = await requireSession();
  if (session.role !== "admin") return { ok: false, error: "Admin only" };
  const email = developerEmail.trim().toLowerCase();
  if (!email?.includes("@")) return { ok: false, error: "Invalid email" };
  const name = developerName.trim() || email;

  return await withOrgScope(session.org.id, async (tx) => {
    let dev = (
      await tx
        .select({ id: developers.id })
        .from(developers)
        .where(eq(developers.email, email))
        .limit(1)
    )[0];
    if (!dev) {
      const created = await tx
        .insert(developers)
        .values({ orgId: session.org.id, email, name })
        .returning({ id: developers.id });
      dev = created[0];
    }
    if (!dev) return { ok: false, error: "Failed to upsert developer" };

    const suffix = randomIdSuffix();
    const id = `bm_${session.org.id}_${suffix}`;
    const secret = randomSecret();
    if (secret.length < 16) return { ok: false, error: "Failed to generate secret" };
    const plaintext = `${id}_${secret}`;
    const keySha256 = sha256Hex(secret);

    await tx.insert(ingestKeys).values({
      id,
      orgId: session.org.id,
      developerId: dev.id,
      keySha256,
    });

    revalidatePath("/admin/keys");
    revalidatePath("/admin/developers");
    return { ok: true, keyId: id, plaintext, developerId: dev.id };
  });
}

export async function revokeKey(
  keyId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  if (session.role !== "admin") return { ok: false, error: "Admin only" };
  if (!keyId.startsWith("bm_")) return { ok: false, error: "Invalid key id" };

  await withOrgScope(session.org.id, async (tx) => {
    await tx.update(ingestKeys).set({ revokedAt: new Date() }).where(eq(ingestKeys.id, keyId));
  });
  revalidatePath("/admin/keys");
  return { ok: true };
}

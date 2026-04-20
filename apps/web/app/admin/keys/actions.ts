"use server";

import { createHash, randomBytes } from "node:crypto";
import { developers, ingestKeys } from "@bematist/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession, withOrgScope } from "@/lib/session";

function randomB64url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function randomIdSuffix(): string {
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

    const keyId = `bm_${session.org.id.replace(/-/g, "").slice(0, 12)}_${randomIdSuffix()}`;
    const secret = randomB64url(24);
    const plaintext = `${keyId}.${secret}`;
    const sha256 = createHash("sha256").update(plaintext).digest("hex");

    await tx.insert(ingestKeys).values({
      id: keyId,
      orgId: session.org.id,
      developerId: dev.id,
      keySha256: sha256,
    });

    revalidatePath("/admin/keys");
    revalidatePath("/admin/developers");
    return { ok: true, keyId, plaintext, developerId: dev.id };
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

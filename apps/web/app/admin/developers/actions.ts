"use server";

import { developers, ingestKeys } from "@bematist/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession, withOrgScope } from "@/lib/session";

type Tier = "claude" | "codex" | "cursor";

export async function updateSubscriptionTier(
  developerId: string,
  tier: Tier,
  value: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  if (session.role !== "admin") return { ok: false, error: "Admin only" };
  if (!/^[0-9a-f-]{36}$/i.test(developerId)) return { ok: false, error: "Invalid developer id" };
  if (value.length > 50) return { ok: false, error: "Value too long" };

  await withOrgScope(session.org.id, async (tx) => {
    const update: Record<string, string | null> = {};
    if (tier === "claude") update.subscriptionClaude = value || null;
    if (tier === "codex") update.subscriptionCodex = value || null;
    if (tier === "cursor") update.subscriptionCursor = value || null;
    await tx.update(developers).set(update).where(eq(developers.id, developerId));
  });
  revalidatePath("/admin/developers");
  return { ok: true };
}

export async function revokeAllKeysForDeveloper(
  developerId: string,
): Promise<{ ok: true; revoked: number } | { ok: false; error: string }> {
  const session = await requireSession();
  if (session.role !== "admin") return { ok: false, error: "Admin only" };
  if (!/^[0-9a-f-]{36}$/i.test(developerId)) return { ok: false, error: "Invalid developer id" };

  const revoked = await withOrgScope(session.org.id, async (tx) => {
    const result = await tx
      .update(ingestKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(ingestKeys.developerId, developerId), isNull(ingestKeys.revokedAt)))
      .returning({ id: ingestKeys.id });
    return result.length;
  });
  revalidatePath("/admin/developers");
  revalidatePath("/admin/keys");
  return { ok: true, revoked };
}

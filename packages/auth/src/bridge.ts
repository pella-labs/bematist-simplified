export type BridgeRole = "admin" | "member";

export interface BridgeUserRow {
  id: string;
  orgId: string;
  role: BridgeRole;
  betterAuthUserId: string | null;
}

export interface BridgeDeps {
  findUserByBetterAuthId: (betterAuthUserId: string) => Promise<BridgeUserRow | null>;
  findUserByEmail: (email: string) => Promise<BridgeUserRow | null>;
  linkBetterAuthIdToUser: (userId: string, betterAuthUserId: string) => Promise<void>;
}

export interface BridgeInput {
  betterAuthUserId: string;
  email: string;
}

export type BridgeResult =
  | { action: "already_bridged"; userId: string; orgId: string; role: BridgeRole }
  | { action: "claimed_existing_invite"; userId: string; orgId: string; role: BridgeRole }
  | { action: "needs_bootstrap" };

/**
 * Resolve a Better-Auth identity against our tenant-scoped `users` table.
 *
 * Three branches:
 *  1. already_bridged: a `users` row already has this betterAuthUserId.
 *  2. claimed_existing_invite: a pre-seeded `users` row with the same email
 *     exists but is unlinked — back-fill the FK and keep its role.
 *  3. needs_bootstrap: no row found. Caller must route the user to
 *     /post-auth/new-org or /post-auth/accept-invite; we cannot create a
 *     `users` row without knowing `org_id`.
 */
export async function resolveBridgedUser(
  deps: BridgeDeps,
  input: BridgeInput,
): Promise<BridgeResult> {
  const existing = await deps.findUserByBetterAuthId(input.betterAuthUserId);
  if (existing) {
    return {
      action: "already_bridged",
      userId: existing.id,
      orgId: existing.orgId,
      role: normalizeRole(existing.role),
    };
  }

  const byEmail = await deps.findUserByEmail(input.email);
  if (byEmail && byEmail.betterAuthUserId === null) {
    await deps.linkBetterAuthIdToUser(byEmail.id, input.betterAuthUserId);
    return {
      action: "claimed_existing_invite",
      userId: byEmail.id,
      orgId: byEmail.orgId,
      role: normalizeRole(byEmail.role),
    };
  }

  return { action: "needs_bootstrap" };
}

function normalizeRole(role: BridgeRole | string): BridgeRole {
  return role === "admin" ? "admin" : "member";
}

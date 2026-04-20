import { expect, test } from "bun:test";
import { type BridgeDeps, type BridgeUserRow, resolveBridgedUser } from "./bridge";

function fakeDeps(init: {
  byBetterAuthId?: Map<string, BridgeUserRow>;
  byEmail?: Map<string, BridgeUserRow>;
  onLink?: (userId: string, betterAuthUserId: string) => void;
}): BridgeDeps {
  const byBetterAuthId = init.byBetterAuthId ?? new Map();
  const byEmail = init.byEmail ?? new Map();
  return {
    findUserByBetterAuthId: async (id) => byBetterAuthId.get(id) ?? null,
    findUserByEmail: async (email) => byEmail.get(email.toLowerCase()) ?? null,
    linkBetterAuthIdToUser: async (userId, betterAuthUserId) => {
      init.onLink?.(userId, betterAuthUserId);
    },
  };
}

test("already_bridged when betterAuthUserId already resolves", async () => {
  const row: BridgeUserRow = {
    id: "u1",
    orgId: "org1",
    role: "admin",
    betterAuthUserId: "ba_1",
  };
  const deps = fakeDeps({ byBetterAuthId: new Map([["ba_1", row]]) });
  const result = await resolveBridgedUser(deps, { betterAuthUserId: "ba_1", email: "a@x" });
  expect(result.action).toBe("already_bridged");
  if (result.action === "already_bridged") {
    expect(result.userId).toBe("u1");
    expect(result.orgId).toBe("org1");
    expect(result.role).toBe("admin");
  }
});

test("claimed_existing_invite when email row exists but unlinked", async () => {
  const row: BridgeUserRow = {
    id: "u2",
    orgId: "org7",
    role: "member",
    betterAuthUserId: null,
  };
  const linked: Array<{ userId: string; betterAuthUserId: string }> = [];
  const deps = fakeDeps({
    byEmail: new Map([["teammate@example.com", row]]),
    onLink: (userId, betterAuthUserId) => {
      linked.push({ userId, betterAuthUserId });
    },
  });
  const result = await resolveBridgedUser(deps, {
    betterAuthUserId: "ba_2",
    email: "teammate@example.com",
  });
  expect(result.action).toBe("claimed_existing_invite");
  expect(linked).toEqual([{ userId: "u2", betterAuthUserId: "ba_2" }]);
  if (result.action === "claimed_existing_invite") {
    expect(result.role).toBe("member");
    expect(result.orgId).toBe("org7");
  }
});

test("needs_bootstrap when neither betterAuthUserId nor email matches", async () => {
  const deps = fakeDeps({});
  const result = await resolveBridgedUser(deps, {
    betterAuthUserId: "ba_new",
    email: "new@example.com",
  });
  expect(result.action).toBe("needs_bootstrap");
});

test("does not re-link when email row already has a different betterAuthUserId", async () => {
  const row: BridgeUserRow = {
    id: "u3",
    orgId: "org9",
    role: "member",
    betterAuthUserId: "ba_other",
  };
  let linkCalled = false;
  const deps = fakeDeps({
    byEmail: new Map([["shared@x", row]]),
    onLink: () => {
      linkCalled = true;
    },
  });
  const result = await resolveBridgedUser(deps, {
    betterAuthUserId: "ba_me",
    email: "shared@x",
  });
  expect(result.action).toBe("needs_bootstrap");
  expect(linkCalled).toBe(false);
});

test("normalizes unexpected role strings to member", async () => {
  const row: BridgeUserRow = {
    id: "u4",
    orgId: "org4",
    role: "weird-role" as "member",
    betterAuthUserId: "ba_4",
  };
  const deps = fakeDeps({ byBetterAuthId: new Map([["ba_4", row]]) });
  const result = await resolveBridgedUser(deps, { betterAuthUserId: "ba_4", email: "x@y" });
  if (result.action === "already_bridged") {
    expect(result.role).toBe("member");
  }
});

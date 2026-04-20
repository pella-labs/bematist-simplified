import { expect, test } from "bun:test";
import { signInvite, verifyInvite } from "./invite";

const SECRET = "test-secret-0123456789";

test("signInvite then verifyInvite roundtrips the payload", () => {
  const token = signInvite(SECRET, { orgId: "org-1", email: "Alice@Example.com" });
  const result = verifyInvite(SECRET, token);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.payload.orgId).toBe("org-1");
    expect(result.payload.email).toBe("alice@example.com");
    expect(result.payload.role).toBe("member");
    expect(result.payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  }
});

test("verifyInvite rejects a tampered payload", () => {
  const token = signInvite(SECRET, { orgId: "org-1", email: "a@x" });
  const [, mac] = token.split(".");
  // Swap the payload for a different org while keeping the original MAC.
  const forgedPayload = Buffer.from(
    JSON.stringify({
      orgId: "attacker",
      email: "a@x",
      role: "member",
      exp: Math.floor(Date.now() / 1000) + 60,
    }),
    "utf8",
  )
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const result = verifyInvite(SECRET, `${forgedPayload}.${mac}`);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("bad_signature");
});

test("verifyInvite rejects a different secret", () => {
  const token = signInvite(SECRET, { orgId: "org-1", email: "a@x" });
  const result = verifyInvite("wrong-secret", token);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("bad_signature");
});

test("verifyInvite rejects a malformed token", () => {
  expect(verifyInvite(SECRET, "").ok).toBe(false);
  expect(verifyInvite(SECRET, "no-dot").ok).toBe(false);
  expect(verifyInvite(SECRET, "a.b.c").ok).toBe(false);
});

test("verifyInvite rejects an expired token", () => {
  const past = 1_000_000_000;
  const token = signInvite(SECRET, {
    orgId: "org-1",
    email: "a@x",
    ttlSeconds: 60,
    now: () => past,
  });
  const result = verifyInvite(SECRET, token, { now: () => past + 120 });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("expired");
});

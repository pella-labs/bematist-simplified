export type { BridgeDeps, BridgeInput, BridgeResult, BridgeRole, BridgeUserRow } from "./bridge";
export { resolveBridgedUser } from "./bridge";
export type { InvitePayload, InviteSignOptions, VerifyInviteResult } from "./invite";
export { signInvite, verifyInvite } from "./invite";
export type { Auth, AuthServerConfig } from "./server";
export {
  betterAuthAccount,
  betterAuthSession,
  betterAuthUser,
  betterAuthVerification,
  createAuth,
  getAuth,
} from "./server";

// NOTE: applyAuthMigrations lives in ./migrations behind the @bematist/auth/migrations
// subpath export. It reads from disk via new URL(..., import.meta.url) which trips
// Next.js' bundler; migrations are a deploy/test-time concern and have no place in
// the web runtime bundle.

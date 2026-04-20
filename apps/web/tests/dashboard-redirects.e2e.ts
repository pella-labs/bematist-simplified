import { expect, test } from "@playwright/test";

/**
 * Dashboard Playwright smoke suite. These run against the dev server and assume:
 * - Postgres reachable via DATABASE_URL with migrations applied
 * - GitHub OAuth is configured or an auth stub is in place
 *
 * Unauthenticated navigation to any /overview, /me, /sessions, /developers, /prompts,
 * /compare, or /admin/* URL must redirect to /auth/sign-in. That's what this suite covers
 * without requiring a real OAuth roundtrip. The full signed-in flow (overview numbers,
 * per-developer page, admin tier override) is documented below for manual verification.
 *
 * Manual end-to-end verification (5 min):
 *  1. `docker compose up postgres` and run migrations.
 *  2. Start web with `bun run dev`, api with `bun run --cwd apps/api dev`.
 *  3. Visit /auth/sign-in, sign in with GitHub.
 *  4. If first login in the org, bootstrap at /post-auth/new-org.
 *  5. Open /admin/keys, mint an ingest key for your email. Copy it.
 *  6. Run `bematist login` with the key, then `bematist run`.
 *  7. Back in the browser, visit /overview. Expect: tiles populate within ~5s.
 *  8. Visit /me — your linked developer appears.
 *  9. Visit /sessions/<id> — transcript renders with events.
 * 10. Visit /admin/developers, change a subscription tier, reload /overview — delta updates.
 */

const PROTECTED_PATHS = [
  "/overview",
  "/me",
  "/sessions",
  "/developers",
  "/prompts",
  "/compare",
  "/admin/developers",
  "/admin/keys",
];

test.describe("dashboard auth gating", () => {
  for (const path of PROTECTED_PATHS) {
    test(`unauthenticated ${path} redirects to sign-in`, async ({ page }) => {
      const res = await page.goto(path, { waitUntil: "domcontentloaded" });
      // Either a server-side 3xx landing us at /auth/sign-in, or a client-side redirect
      // leaves the URL on /auth/sign-in.
      await page.waitForURL(/\/auth\/sign-in/);
      expect(page.url()).toContain("/auth/sign-in");
      expect(res).toBeTruthy();
    });
  }
});

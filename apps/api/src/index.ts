import type { Sql } from "postgres";
import postgres from "postgres";
import { ApiError } from "./errors";
import {
  createInMemoryInstallationTokenCache,
  type InstallationTokenCache,
} from "./github/install";
import { githubWebhookRoute } from "./github/webhook";
import { eventsRoute } from "./routes/events";
import { healthRoute } from "./routes/health";

export interface ServerDeps {
  sql: Sql;
  /**
   * Optional BYPASSRLS connection. The GitHub webhook receiver needs one
   * for the two cross-tenant reads (installation lookup + webhook_deliveries
   * dedup) that cannot assume a tenant. Falls back to `sql`.
   */
  adminSql?: Sql;
  port?: number;
  /**
   * GitHub webhook HMAC secret. Optional so tests can boot without it; in
   * prod, boot will refuse to start if GITHUB_WEBHOOK_SECRET is missing and
   * a webhook request arrives.
   */
  githubWebhookSecret?: string;
  githubAppId?: string | number;
  githubAppPrivateKey?: string;
  tokenCache?: InstallationTokenCache;
}

const WEBHOOK_PATH = /^\/v1\/webhooks\/github$/;

export function createFetchHandler(deps: ServerDeps): (req: Request) => Promise<Response> {
  const tokenCache = deps.tokenCache ?? createInMemoryInstallationTokenCache();
  return async (req) => {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return healthRoute();
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        return healthRoute();
      }
      if (req.method === "POST" && url.pathname === "/v1/events") {
        return await eventsRoute(req, deps.sql);
      }
      if (WEBHOOK_PATH.test(url.pathname) && req.method === "POST") {
        if (!deps.githubWebhookSecret) {
          return Response.json(
            { error: { code: "internal_error", message: "webhook secret not configured" } },
            { status: 500 },
          );
        }
        return await githubWebhookRoute(req, {
          sql: deps.sql,
          adminSql: deps.adminSql,
          webhookSecret: deps.githubWebhookSecret,
          tokenCache,
          githubAppId: deps.githubAppId,
          githubAppPrivateKey: deps.githubAppPrivateKey,
        });
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      if (err instanceof ApiError) return err.toResponse();
      console.error("[api] unhandled error", err);
      return Response.json(
        { error: { code: "internal_error", message: "internal error" } },
        { status: 500 },
      );
    }
  };
}

export function startServer(deps: ServerDeps) {
  const port = deps.port ?? Number(process.env.PORT ?? 8000);
  const fetchHandler = createFetchHandler(deps);
  return Bun.serve({ port, fetch: fetchHandler });
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[api] DATABASE_URL is required");
    process.exit(1);
  }
  // In prod, DATABASE_URL must use the app_bematist role (NOBYPASSRLS),
  // not the superuser — WS-1's 0003_rls.sql creates the role + grants.
  const sql = postgres(databaseUrl, { prepare: false });
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const adminSql = adminUrl ? postgres(adminUrl, { prepare: false, max: 2 }) : undefined;
  const server = startServer({
    sql,
    adminSql,
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    githubAppId: process.env.GITHUB_APP_ID,
    githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  });
  console.log(`[api] listening on http://localhost:${server.port}`);
}

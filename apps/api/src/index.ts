import type { Sql } from "postgres";
import postgres from "postgres";
import { ApiError } from "./errors";
import { eventsRoute } from "./routes/events";
import { healthRoute } from "./routes/health";

export interface ServerDeps {
  sql: Sql;
  port?: number;
}

export function createFetchHandler(sql: Sql): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return healthRoute();
      }
      if (req.method === "POST" && url.pathname === "/v1/events") {
        return await eventsRoute(req, sql);
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
  const fetchHandler = createFetchHandler(deps.sql);
  return Bun.serve({ port, fetch: fetchHandler });
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[api] DATABASE_URL is required");
    process.exit(1);
  }
  const sql = postgres(databaseUrl, { prepare: false });
  const server = startServer({ sql });
  console.log(`[api] listening on http://localhost:${server.port}`);
}

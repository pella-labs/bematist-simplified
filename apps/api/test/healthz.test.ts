import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import type { Sql } from "postgres";
import { startServer } from "../src/index";
import { createTestSchema, type TestSchema } from "./fixtures/db";

let db: TestSchema;
let sql: Sql;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  db = await createTestSchema();
  sql = db.sql;
  server = startServer({ sql, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await db.close();
});

describe("GET /healthz", () => {
  it("returns 200 with { ok: true }", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
  });

  it("returns application/json content-type", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("returns 404 for other methods", async () => {
    const res = await fetch(`${baseUrl}/healthz`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

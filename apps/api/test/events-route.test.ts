import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import type { Sql } from "postgres";
import { startServer } from "../src/index";
import { createTestSchema, seedIngestKey, type TestSchema } from "./fixtures/db";
import { makeEnvelope } from "./fixtures/envelopes";

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

describe("POST /v1/events", () => {
  it("accepts a valid batch and returns { accepted, deduped }", async () => {
    const seeded = await seedIngestKey(sql);
    const events = [
      makeEnvelope({ source_session_id: "route-s", event_seq: 0 }),
      makeEnvelope({ source_session_id: "route-s", event_seq: 1 }),
    ];
    const res = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${seeded.bearer}`,
      },
      body: JSON.stringify(events),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: number; deduped: number };
    expect(body).toEqual({ accepted: 2, deduped: 0 });
  });

  it("returns 401 for missing bearer", async () => {
    const res = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([makeEnvelope()]),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 401 for an unknown key", async () => {
    const badBearer = `bm_00000000-0000-0000-0000-000000000000_abcdef1234567890_${"z".repeat(64)}`;
    const res = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${badBearer}`,
      },
      body: JSON.stringify([makeEnvelope()]),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON", async () => {
    const seeded = await seedIngestKey(sql);
    const res = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${seeded.bearer}`,
      },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  it("returns 400 for a batch with unknown fields", async () => {
    const seeded = await seedIngestKey(sql);
    const evil = [{ ...makeEnvelope(), extra: 1 }];
    const res = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${seeded.bearer}`,
      },
      body: JSON.stringify(evil),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });

  it("serves GET /health", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

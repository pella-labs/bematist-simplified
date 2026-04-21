import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@bematist/contracts";
import {
  UploadAuthError,
  Uploader,
  UploadPermanentError,
  UploadRetriesExhaustedError,
} from "../src/uploader";

function env(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  const base: EventEnvelope = {
    client_event_id: randomUUID(),
    schema_version: 1,
    session_id: "sess-1",
    source_session_id: "src-sess-1",
    source: "claude-code",
    source_version: "1.0.0",
    client_version: "0.1.0",
    ts: new Date().toISOString(),
    event_seq: 0,
    kind: "user_prompt",
    payload: { kind: "user_prompt", text: "hi" },
    cwd: null,
    git_branch: null,
    git_sha: null,
    model: null,
    usage: null,
    duration_ms: null,
    success: null,
    raw: null,
  };
  return { ...base, ...overrides };
}

function jsonRes(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function makeUploader(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  opts: Partial<ConstructorParameters<typeof Uploader>[0]> = {},
) {
  return new Uploader({
    apiUrl: "http://example.invalid",
    ingestKey: "bm_test_key_secret",
    clientVersion: "0.1.0",
    baseDelayMs: 1,
    maxDelayMs: 2,
    maxRetries: 3,
    sleep: async () => {},
    fetch: fetchImpl,
    ...opts,
  });
}

describe("Uploader", () => {
  it("POSTs to /v1/events with bearer and returns the server shape", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const uploader = makeUploader(async (url, init) => {
      calls.push({ url, init });
      return jsonRes({ accepted: 1, deduped: 0 });
    });
    const result = await uploader.upload([env()]);
    expect(result).toEqual({ accepted: 1, deduped: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://example.invalid/v1/events");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("authorization")).toBe("Bearer bm_test_key_secret");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("user-agent")).toBe("bm-pilot-ingest/0.1.0");
    expect(calls[0].init.method).toBe("POST");
  });

  it("retries on 5xx with exponential backoff until it succeeds", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const uploader = makeUploader(
      async () => {
        attempts++;
        if (attempts < 3) return new Response("boom", { status: 503 });
        return jsonRes({ accepted: 1, deduped: 0 });
      },
      {
        sleep: async (ms) => void sleeps.push(ms),
        baseDelayMs: 10,
        maxDelayMs: 1000,
        maxRetries: 5,
      },
    );
    const result = await uploader.upload([env()]);
    expect(result).toEqual({ accepted: 1, deduped: 0 });
    expect(attempts).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(10);
    expect(sleeps[1]).toBeGreaterThanOrEqual(sleeps[0]);
  });

  it("retries on 429 and respects Retry-After header", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const uploader = makeUploader(
      async () => {
        attempts++;
        if (attempts === 1) {
          return new Response("slow down", { status: 429, headers: { "Retry-After": "2" } });
        }
        return jsonRes({ accepted: 1, deduped: 0 });
      },
      { sleep: async (ms) => void sleeps.push(ms), maxDelayMs: 10_000 },
    );
    await uploader.upload([env()]);
    expect(sleeps[0]).toBe(2000);
  });

  it("throws UploadAuthError on 401 without retry", async () => {
    let attempts = 0;
    const uploader = makeUploader(async () => {
      attempts++;
      return new Response("nope", { status: 401 });
    });
    await expect(uploader.upload([env()])).rejects.toBeInstanceOf(UploadAuthError);
    expect(attempts).toBe(1);
  });

  it("throws UploadPermanentError on 400 without retry", async () => {
    let attempts = 0;
    const uploader = makeUploader(async () => {
      attempts++;
      return new Response("bad", { status: 400 });
    });
    await expect(uploader.upload([env()])).rejects.toBeInstanceOf(UploadPermanentError);
    expect(attempts).toBe(1);
  });

  it("gives up after maxRetries on repeated 5xx", async () => {
    let attempts = 0;
    const uploader = makeUploader(
      async () => {
        attempts++;
        return new Response("down", { status: 500 });
      },
      { maxRetries: 2 },
    );
    await expect(uploader.upload([env()])).rejects.toBeInstanceOf(UploadRetriesExhaustedError);
    expect(attempts).toBe(3);
  });

  it("returns {0,0} for empty batches without a network call", async () => {
    let called = false;
    const uploader = makeUploader(async () => {
      called = true;
      return jsonRes({ accepted: 999, deduped: 0 });
    });
    const result = await uploader.upload([]);
    expect(result).toEqual({ accepted: 0, deduped: 0 });
    expect(called).toBe(false);
  });

  it("reports deduped counts back to the caller", async () => {
    const uploader = makeUploader(async () => jsonRes({ accepted: 3, deduped: 2 }));
    const result = await uploader.upload([env(), env(), env(), env(), env()]);
    expect(result).toEqual({ accepted: 3, deduped: 2 });
  });
});

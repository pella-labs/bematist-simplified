import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GET } from "./route";

describe("GET /install.sh", () => {
  const savedPublic = process.env.INGEST_API_PUBLIC_URL;
  const savedInternal = process.env.INGEST_API_URL;

  beforeEach(() => {
    delete process.env.INGEST_API_PUBLIC_URL;
    delete process.env.INGEST_API_URL;
  });

  afterEach(() => {
    if (savedPublic !== undefined) process.env.INGEST_API_PUBLIC_URL = savedPublic;
    else delete process.env.INGEST_API_PUBLIC_URL;
    if (savedInternal !== undefined) process.env.INGEST_API_URL = savedInternal;
    else delete process.env.INGEST_API_URL;
  });

  test("serves text/x-shellscript content-type", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-shellscript");
  });

  test("body starts with shebang", async () => {
    const res = await GET();
    const body = await res.text();
    expect(body.startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  test("sets a cache-control header", async () => {
    const res = await GET();
    expect(res.headers.get("cache-control")).toContain("max-age=60");
  });

  test("substitutes {{API_URL}} from INGEST_API_PUBLIC_URL", async () => {
    process.env.INGEST_API_PUBLIC_URL = "https://api.example.com";
    const res = await GET();
    const body = await res.text();
    expect(body).not.toContain("{{API_URL}}");
    expect(body).toContain('API_URL_TEMPLATE="https://api.example.com"');
  });

  test("prefers INGEST_API_PUBLIC_URL over INGEST_API_URL", async () => {
    process.env.INGEST_API_PUBLIC_URL = "https://public.example.com";
    process.env.INGEST_API_URL = "http://internal:8000";
    const res = await GET();
    const body = await res.text();
    expect(body).toContain('API_URL_TEMPLATE="https://public.example.com"');
    expect(body).not.toContain("http://internal:8000");
  });

  test("falls back to INGEST_API_URL when INGEST_API_PUBLIC_URL is unset", async () => {
    process.env.INGEST_API_URL = "http://api.railway.internal:8000";
    const res = await GET();
    const body = await res.text();
    expect(body).not.toContain("{{API_URL}}");
    expect(body).toContain('API_URL_TEMPLATE="http://api.railway.internal:8000"');
  });

  test("substitutes with empty string when no env var is set (keeps script runnable)", async () => {
    const res = await GET();
    const body = await res.text();
    expect(body).not.toContain("{{API_URL}}");
    // The bash `case` in install.sh must still handle the empty substitution
    // gracefully, i.e. the seeding block is skipped and the installer still works.
    expect(body).toContain('API_URL_TEMPLATE=""');
  });
});

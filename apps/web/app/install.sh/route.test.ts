import { describe, expect, test } from "bun:test";
import { GET } from "./route";

describe("GET /install.sh", () => {
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
});

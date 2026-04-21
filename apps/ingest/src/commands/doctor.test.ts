import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshConfig, writeConfig } from "../config";
import { runDoctor } from "./doctor";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bm-pilot-doctor-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const KEY = `bm_01234567-89ab-cdef-0123-456789abcdef_keyId012_${"a".repeat(32)}`;

describe("runDoctor", () => {
  it("reports missing config as a critical failure", async () => {
    const res = await runDoctor({
      configPath: join(tmp, "config.json"),
      home: tmp,
      platform: "linux",
      env: {},
      fetchImpl: async () => new Response("ok"),
      serviceStatus: async () => ({
        platform: "linux",
        installed: false,
        running: false,
        pid: null,
        uptimeSec: null,
      }),
    });
    expect(res.exitCode).toBe(1);
    expect(res.checks.find((c) => c.name === "config")?.ok).toBe(false);
  });

  it("passes all critical checks on a healthy install", async () => {
    const cfgPath = join(tmp, "config.json");
    await writeConfig({ ...freshConfig("http://localhost:8000"), ingestKey: KEY }, cfgPath);
    await mkdir(join(tmp, ".claude"), { recursive: true });

    const res = await runDoctor({
      configPath: cfgPath,
      home: tmp,
      platform: "linux",
      env: {},
      fetchImpl: async () => new Response("ok", { status: 200 }),
      serviceStatus: async () => ({
        platform: "linux",
        installed: true,
        running: true,
        pid: 1234,
        uptimeSec: 60,
      }),
    });
    expect(res.exitCode).toBe(0);
    expect(res.checks.every((c) => c.ok || !c.critical)).toBe(true);
    expect(res.checks.find((c) => c.name === "token-format")?.ok).toBe(true);
    expect(res.checks.find((c) => c.name === "api-reachable")?.ok).toBe(true);
    expect(res.checks.find((c) => c.name === "service")?.ok).toBe(true);
  });

  it("flags invalid token format", async () => {
    const cfgPath = join(tmp, "config.json");
    const cfg = freshConfig("http://localhost:8000");
    // Write bypassing validator: inject via direct filesystem write.
    const raw = JSON.stringify({ ...cfg, ingestKey: "bm_not_valid" });
    await mkdir(tmp, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(cfgPath, raw);

    const res = await runDoctor({
      configPath: cfgPath,
      home: tmp,
      platform: "linux",
      env: {},
      fetchImpl: async () => new Response("ok"),
      serviceStatus: async () => ({
        platform: "linux",
        installed: true,
        running: true,
        pid: 1,
        uptimeSec: 1,
      }),
    });
    // Either config load fails (strict schema) or token-format fails; both end in exit 1.
    expect(res.exitCode).toBe(1);
  });

  it("flags api unreachable", async () => {
    const cfgPath = join(tmp, "config.json");
    await writeConfig({ ...freshConfig("http://localhost:8000"), ingestKey: KEY }, cfgPath);
    const res = await runDoctor({
      configPath: cfgPath,
      home: tmp,
      platform: "linux",
      env: {},
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
      serviceStatus: async () => ({
        platform: "linux",
        installed: true,
        running: true,
        pid: 1,
        uptimeSec: 1,
      }),
    });
    const apiCheck = res.checks.find((c) => c.name === "api-reachable");
    expect(apiCheck?.ok).toBe(false);
    expect(res.exitCode).toBe(1);
  });

  it("renders JSON when jsonOutput=true", async () => {
    const cfgPath = join(tmp, "config.json");
    await writeConfig({ ...freshConfig("http://localhost:8000"), ingestKey: KEY }, cfgPath);
    const res = await runDoctor({
      configPath: cfgPath,
      home: tmp,
      platform: "linux",
      env: {},
      fetchImpl: async () => new Response("ok"),
      serviceStatus: async () => ({
        platform: "linux",
        installed: true,
        running: true,
        pid: 1,
        uptimeSec: 1,
      }),
      jsonOutput: true,
    });
    const parsed = JSON.parse(res.output);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });

  it("human output contains [ok] / [fail] markers", async () => {
    const cfgPath = join(tmp, "config.json");
    await writeConfig({ ...freshConfig("http://localhost:8000"), ingestKey: KEY }, cfgPath);
    const res = await runDoctor({
      configPath: cfgPath,
      home: tmp,
      platform: "linux",
      env: {},
      fetchImpl: async () => new Response("ok"),
      serviceStatus: async () => ({
        platform: "linux",
        installed: true,
        running: true,
        pid: 1,
        uptimeSec: 1,
      }),
    });
    expect(res.output).toMatch(/\[ok\]|\[fail\]|\[skip\]/);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { freshConfig, readConfig, writeConfig } from "../src/config";

interface Captured {
  out: string[];
  err: string[];
}

function captureIO(
  argv: string[],
  extras: Partial<Parameters<typeof run>[0]> = {},
): {
  io: Parameters<typeof run>[0];
  captured: Captured;
} {
  const captured: Captured = { out: [], err: [] };
  const io: Parameters<typeof run>[0] = {
    argv: ["bun", "bematist", ...argv],
    stdout: { write: (c: string) => captured.out.push(c) },
    stderr: { write: (c: string) => captured.err.push(c) },
    env: {},
    ...extras,
  };
  return { io, captured };
}

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bematist-cli-"));
  path = join(dir, "config.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("cli", () => {
  it("prints help and returns 0", async () => {
    const { io, captured } = captureIO(["help"], { configPath: path });
    expect(await run(io)).toBe(0);
    expect(captured.out.join("")).toContain("bematist");
    expect(captured.out.join("")).toContain("login");
  });

  it("prints version", async () => {
    const { io, captured } = captureIO(["version"], { configPath: path });
    expect(await run(io)).toBe(0);
    expect(captured.out.join("").trim()).toMatch(/\d+\.\d+\.\d+/);
  });

  it("status prints expected keys when no config exists", async () => {
    const { io, captured } = captureIO(["status"], { configPath: path });
    expect(await run(io)).toBe(0);
    const body = JSON.parse(captured.out.join(""));
    expect(body).toMatchObject({
      configPath: path,
      loggedIn: false,
      apiUrl: null,
      deviceId: null,
    });
    expect(body).toHaveProperty("clientVersion");
    expect(body).toHaveProperty("lastFlushAt");
    expect(body).toHaveProperty("installedAt");
    expect(body).toHaveProperty("adapters");
  });

  it("login writes an ingest key to config", async () => {
    const key = `bm_00000000-0000-0000-0000-000000000000_keyid123_${"s".repeat(32)}`;
    const { io } = captureIO(["login"], {
      configPath: path,
      prompt: async () => key,
    });
    expect(await run(io)).toBe(0);
    const c = await readConfig(path);
    expect(c?.ingestKey).toBe(key);
  });

  it("login rejects a malformed key", async () => {
    const { io, captured } = captureIO(["login"], {
      configPath: path,
      prompt: async () => "not-a-key",
    });
    expect(await run(io)).toBe(1);
    expect(captured.err.join("")).toContain("login failed");
  });

  it("logout preserves apiUrl and clears the key", async () => {
    const c = freshConfig("http://api.example.com");
    c.ingestKey = `bm_00000000-0000-0000-0000-000000000000_keyid123_${"t".repeat(32)}`;
    await writeConfig(c, path);
    const { io } = captureIO(["logout"], { configPath: path });
    expect(await run(io)).toBe(0);
    const after = await readConfig(path);
    expect(after?.apiUrl).toBe("http://api.example.com");
    expect(after?.ingestKey).toBeNull();
  });

  it("logout fails when no config exists", async () => {
    const { io, captured } = captureIO(["logout"], { configPath: path });
    expect(await run(io)).toBe(1);
    expect(captured.err.join("")).toContain("no config found");
  });

  it("run refuses to start without a stored ingest key", async () => {
    await writeConfig(freshConfig(), path);
    const { io, captured } = captureIO(["run"], { configPath: path });
    expect(await run(io)).toBe(1);
    expect(captured.err.join("")).toContain("not logged in");
  });

  it("uninstall prints a removal checklist", async () => {
    const { io, captured } = captureIO(["uninstall"], { configPath: path });
    expect(await run(io)).toBe(0);
    const text = captured.out.join("");
    expect(text).toContain("uninstall");
    expect(text).toContain("~/.local/bin/bematist");
  });

  it("rejects unknown commands with exit code 2", async () => {
    const { io, captured } = captureIO(["whatever"], { configPath: path });
    expect(await run(io)).toBe(2);
    expect(captured.err.join("")).toContain("unknown command");
  });
});

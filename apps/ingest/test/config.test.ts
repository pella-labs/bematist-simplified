import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshConfig, readConfig, writeConfig } from "../src/config";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bm-pilot-cfg-"));
  path = join(dir, "nested", "config.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("config", () => {
  it("returns null when no config file exists", async () => {
    expect(await readConfig(path)).toBeNull();
  });

  it("writes and reads a round-trip config", async () => {
    const c = freshConfig("http://localhost:9999");
    c.ingestKey = `bm_00000000-0000-0000-0000-000000000000_keyid123_${"a".repeat(32)}`;
    await writeConfig(c, path);
    const again = await readConfig(path);
    expect(again).toEqual(c);
  });

  it("writes atomically — no tmp file remains after success", async () => {
    await writeConfig(freshConfig(), path);
    const parent = join(dir, "nested");
    const entries = await readdir(parent);
    expect(entries.some((e) => e.includes(".tmp-"))).toBe(false);
  });

  it("concurrent writers do not corrupt the file", async () => {
    const writers = [];
    for (let i = 0; i < 8; i++) {
      const c = freshConfig("http://concurrent.example.com");
      c.ingestKey =
        `bm_00000000-0000-0000-0000-000000000000_key${i.toString().padStart(8, "0")}_` +
        "b".repeat(32);
      writers.push(writeConfig(c, path));
    }
    await Promise.all(writers);
    const final = await readConfig(path);
    expect(final).not.toBeNull();
    expect(final?.apiUrl).toBe("http://concurrent.example.com");
    const raw = await readFile(path, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const parent = join(dir, "nested");
    const entries = await readdir(parent);
    const leftover = entries.filter((e) => e.includes(".tmp-"));
    expect(leftover).toEqual([]);
  });

  it("rejects malformed config", async () => {
    await writeConfig(freshConfig(), path);
    await Bun.write(path, '{"apiUrl":"not-a-url"}');
    await expect(readConfig(path)).rejects.toThrow();
  });

  it("creates the parent directory if missing", async () => {
    const deep = join(dir, "a", "b", "c", "config.json");
    await writeConfig(freshConfig(), deep);
    await access(deep);
  });
});

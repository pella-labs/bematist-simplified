import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCurrentSession, writeCurrentSession } from "./currentSession";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = join(tmpdir(), `bm-pilot-cs-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  path = join(dir, "current-session");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("currentSession", () => {
  test("writeCurrentSession writes exactly the id with a trailing newline", async () => {
    const id = "12345678-1234-1234-1234-123456789abc";
    await writeCurrentSession(id, path);
    const raw = await readFile(path, "utf8");
    expect(raw).toBe(`${id}\n`);
  });

  test("write is atomic-ish — rewrite replaces the value without corruption", async () => {
    await writeCurrentSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", path);
    await writeCurrentSession("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", path);
    const raw = await readFile(path, "utf8");
    expect(raw.trim()).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  test("clearCurrentSession removes the file", async () => {
    await writeCurrentSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", path);
    await clearCurrentSession(path);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("clearCurrentSession on a missing file is a no-op", async () => {
    await expect(clearCurrentSession(path)).resolves.toBeUndefined();
  });
});

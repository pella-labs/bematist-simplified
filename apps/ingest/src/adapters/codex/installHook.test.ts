import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_MARKER, installCodexHook, mergeHook } from "./installHook";

const tmpRoots: string[] = [];

afterEach(() => {
  while (tmpRoots.length > 0) {
    const p = tmpRoots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-hook-"));
  tmpRoots.push(dir);
  return dir;
}

describe("installCodexHook", () => {
  it("writes hooks.json on linux/macos with the expected marker", async () => {
    const home = makeHome();
    const result = await installCodexHook({ home, platform: "linux", log: () => {} });
    expect(result.status).toBe("installed");
    expect(result.path).toBe(join(home, ".codex", "hooks.json"));
    const body = JSON.parse(readFileSync(result.path as string, "utf8"));
    expect(Array.isArray(body.hooks)).toBe(true);
    const ours = (body.hooks as Array<{ id: string }>).find((h) => h.id === HOOK_MARKER);
    expect(ours).toBeTruthy();
  });

  it("preserves pre-existing hook entries when merging", async () => {
    const home = makeHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    const existing = {
      hooks: [{ id: "user-custom", event: "SessionStart", command: "echo hi" }],
    };
    writeFileSync(join(home, ".codex", "hooks.json"), JSON.stringify(existing));
    await installCodexHook({ home, platform: "darwin", log: () => {} });
    const body = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
    const ids = (body.hooks as Array<{ id: string }>).map((h) => h.id);
    expect(ids).toContain("user-custom");
    expect(ids).toContain(HOOK_MARKER);
  });

  it("skips write entirely on Windows and logs a clear message", async () => {
    const home = makeHome();
    const messages: string[] = [];
    const result = await installCodexHook({
      home,
      platform: "win32",
      log: (m) => messages.push(m),
    });
    expect(result.status).toBe("skipped_windows");
    expect(result.path).toBeNull();
    expect(messages.join("\n")).toContain("hook install skipped on Windows");
    let err: unknown = null;
    try {
      readFileSync(join(home, ".codex", "hooks.json"));
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
  });

  it("is idempotent — running twice produces the same on-disk state", async () => {
    const home = makeHome();
    const r1 = await installCodexHook({ home, platform: "linux", log: () => {} });
    const after1 = readFileSync(r1.path as string, "utf8");
    const r2 = await installCodexHook({ home, platform: "linux", log: () => {} });
    const after2 = readFileSync(r2.path as string, "utf8");
    expect(after2).toBe(after1);
  });

  it("mergeHook — replaces existing entry with same marker rather than duplicating", () => {
    const stale = {
      hooks: [{ id: HOOK_MARKER, event: "SessionStart", command: "/old/bematist capture-git-sha" }],
    };
    const res = mergeHook(stale, {
      marker: HOOK_MARKER,
      binary: "/new/bematist",
      queueDir: "/q",
    });
    const hooks = res.value.hooks as Array<{ id: string; command: string }>;
    expect(hooks.filter((h) => h.id === HOOK_MARKER).length).toBe(1);
    expect(hooks[0]?.command).toContain("/new/bematist");
  });
});

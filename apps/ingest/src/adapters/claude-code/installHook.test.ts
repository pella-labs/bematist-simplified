import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_COMMAND, installClaudeSessionStartHook } from "./installHook";

let tmp: string;
let settingsPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bm-pilot-hook-"));
  await mkdir(join(tmp, ".claude"), { recursive: true });
  settingsPath = join(tmp, ".claude", "settings.json");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("installClaudeSessionStartHook", () => {
  it("creates settings.json with SessionStart hook when file missing", async () => {
    const res = await installClaudeSessionStartHook({ settingsPath });
    expect(res.changed).toBe(true);
    expect(res.backedUpTo).toBeNull();
    const written = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(written.hooks.SessionStart[0].hooks[0]).toEqual({
      type: "command",
      command: HOOK_COMMAND,
    });
  });

  it("preserves unrelated settings keys", async () => {
    const seed = {
      cleanupPeriodDays: 365,
      permissions: { allow: ["mcp__pencil"] },
      statusLine: { type: "command", command: "echo" },
    };
    await writeFile(settingsPath, JSON.stringify(seed, null, 2));
    const res = await installClaudeSessionStartHook({ settingsPath });
    expect(res.changed).toBe(true);
    const written = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(written.cleanupPeriodDays).toBe(365);
    expect(written.permissions.allow).toEqual(["mcp__pencil"]);
    expect(written.statusLine.command).toBe("echo");
    expect(written.hooks.SessionStart[0].hooks[0].command).toBe(HOOK_COMMAND);
  });

  it("preserves existing SessionStart hooks from other tools", async () => {
    const seed = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "other-tool" }],
          },
        ],
      },
    };
    await writeFile(settingsPath, JSON.stringify(seed, null, 2));
    const res = await installClaudeSessionStartHook({ settingsPath });
    expect(res.changed).toBe(true);
    const written = JSON.parse(await readFile(settingsPath, "utf8"));
    const commands = written.hooks.SessionStart[0].hooks.map((h: { command: string }) => h.command);
    expect(commands).toContain("other-tool");
    expect(commands).toContain(HOOK_COMMAND);
  });

  it("backs up to .bak on first change", async () => {
    const seed = { someKey: 1 };
    await writeFile(settingsPath, JSON.stringify(seed));
    const res = await installClaudeSessionStartHook({ settingsPath });
    expect(res.backedUpTo).toBe(`${settingsPath}.bak`);
    const bak = await readFile(`${settingsPath}.bak`, "utf8");
    expect(JSON.parse(bak)).toEqual(seed);
  });

  it("does not overwrite an existing .bak on subsequent changes", async () => {
    const seed1 = { someKey: 1 };
    await writeFile(settingsPath, JSON.stringify(seed1));
    await installClaudeSessionStartHook({ settingsPath });
    // Mutate the file by hand, then add a second bm-pilot run.
    const current = JSON.parse(await readFile(settingsPath, "utf8"));
    delete current.hooks;
    current.someKey = 2;
    await writeFile(settingsPath, JSON.stringify(current));
    await installClaudeSessionStartHook({ settingsPath });
    const bak = JSON.parse(await readFile(`${settingsPath}.bak`, "utf8"));
    expect(bak).toEqual(seed1);
  });

  it("is idempotent — running twice yields one hook entry and no second change", async () => {
    await installClaudeSessionStartHook({ settingsPath });
    const res2 = await installClaudeSessionStartHook({ settingsPath });
    expect(res2.changed).toBe(false);
    const written = JSON.parse(await readFile(settingsPath, "utf8"));
    const bmPilotEntries = written.hooks.SessionStart.flatMap(
      (g: { hooks: { command: string }[] }) => g.hooks,
    ).filter((h: { command: string }) => h.command === HOOK_COMMAND);
    expect(bmPilotEntries).toHaveLength(1);
  });

  it("does not write .bak when there was no prior file", async () => {
    const res = await installClaudeSessionStartHook({ settingsPath });
    expect(res.backedUpTo).toBeNull();
    await expect(readFile(`${settingsPath}.bak`, "utf8")).rejects.toThrow();
  });

  it("recovers from malformed existing JSON (treats as empty)", async () => {
    await writeFile(settingsPath, "{not json");
    const res = await installClaudeSessionStartHook({ settingsPath });
    expect(res.changed).toBe(true);
    const written = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(written.hooks.SessionStart[0].hooks[0].command).toBe(HOOK_COMMAND);
  });
});

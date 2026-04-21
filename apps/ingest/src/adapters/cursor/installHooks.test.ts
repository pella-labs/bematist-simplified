import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBematistEntry,
  installHooks,
  mergeHooks,
  readHooksFile,
  removeBematistHooks,
} from "./installHooks";
import { CURSOR_HOOK_EVENTS } from "./normalize";

let dir: string;
let hooksPath: string;
const binaryPath = "/usr/local/bin/bm-pilot";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bm-hooks-"));
  hooksPath = join(dir, ".cursor", "hooks.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("installHooks", () => {
  test("creates hooks.json with all 8 bm-pilot entries when file does not exist", async () => {
    const r = await installHooks({ hooksPath, binaryPath });
    expect(r.changed).toBe(true);
    expect(r.backupCreated).toBe(false);
    const file = await readHooksFile(hooksPath);
    expect(file).not.toBeNull();
    for (const event of CURSOR_HOOK_EVENTS) {
      const list = file?.hooks?.[event] ?? [];
      const ours = list.find(
        (e) =>
          typeof e === "object" && e !== null && (e as { source?: string }).source === "bm-pilot",
      );
      expect(ours).toBeDefined();
    }
  });

  test("preserves existing user hooks when adding ours", async () => {
    await mkdir(join(dir, ".cursor"), { recursive: true });
    await writeFile(
      hooksPath,
      JSON.stringify({
        hooks: {
          beforeSubmitPrompt: [{ command: "my-user-script", source: "user" }],
          preToolUse: [{ command: "another-user-script" }],
        },
      }),
    );

    const r = await installHooks({ hooksPath, binaryPath });
    expect(r.changed).toBe(true);
    expect(r.backupCreated).toBe(true);

    const file = await readHooksFile(hooksPath);
    const beforeList = file?.hooks?.beforeSubmitPrompt ?? [];
    expect(beforeList).toHaveLength(2);
    const userEntry = beforeList.find((e) => (e as { source?: string }).source === "user");
    expect(userEntry).toBeDefined();
    expect((userEntry as { command: string }).command).toBe("my-user-script");

    const preList = file?.hooks?.preToolUse ?? [];
    expect(preList).toHaveLength(2);
    expect((preList[0] as { command: string }).command).toBe("another-user-script");
  });

  test("idempotent: running twice yields a single bm-pilot entry per event", async () => {
    await installHooks({ hooksPath, binaryPath });
    const secondRun = await installHooks({ hooksPath, binaryPath });
    expect(secondRun.changed).toBe(false);
    expect(secondRun.backupCreated).toBe(false);

    const file = await readHooksFile(hooksPath);
    for (const event of CURSOR_HOOK_EVENTS) {
      const list = file?.hooks?.[event] ?? [];
      const ours = list.filter(
        (e) =>
          typeof e === "object" && e !== null && (e as { source?: string }).source === "bm-pilot",
      );
      expect(ours).toHaveLength(1);
    }
  });

  test("creates .bak on first change only, not on subsequent changes", async () => {
    await mkdir(join(dir, ".cursor"), { recursive: true });
    await writeFile(hooksPath, JSON.stringify({ hooks: { preToolUse: [{ command: "u" }] } }));

    const first = await installHooks({ hooksPath, binaryPath });
    expect(first.changed).toBe(true);
    expect(first.backupCreated).toBe(true);
    const backupPath = `${hooksPath}.bak`;
    const backupStat = await stat(backupPath);
    expect(backupStat.isFile()).toBe(true);
    const backupContent = JSON.parse(await readFile(backupPath, "utf8"));
    expect(backupContent.hooks.preToolUse[0].command).toBe("u");

    const second = await installHooks({ hooksPath, binaryPath: "/other/bm-pilot" });
    expect(second.changed).toBe(true);
    expect(second.backupCreated).toBe(false);
    const stillOriginal = JSON.parse(await readFile(backupPath, "utf8"));
    expect(stillOriginal.hooks.preToolUse[0].command).toBe("u");
  });

  test("no-consent path: installHooks not called → hooks.json unchanged", async () => {
    await mkdir(join(dir, ".cursor"), { recursive: true });
    const original = { hooks: { preToolUse: [{ command: "user-only" }] } };
    await writeFile(hooksPath, JSON.stringify(original));

    const file = await readHooksFile(hooksPath);
    expect(file).toEqual(original);

    const parsed = JSON.parse(await readFile(hooksPath, "utf8"));
    expect(parsed).toEqual(original);
  });

  test("mergeHooks with null existing yields a minimal hooks object", () => {
    const { next, changed } = mergeHooks(null, binaryPath);
    expect(changed).toBe(true);
    for (const event of CURSOR_HOOK_EVENTS) {
      expect(next.hooks?.[event]).toEqual([buildBematistEntry(binaryPath, event)]);
    }
  });

  test("mergeHooks updates entry when binary path changes", () => {
    const first = mergeHooks(null, binaryPath).next;
    const { next, changed } = mergeHooks(first, "/new/path/bm-pilot");
    expect(changed).toBe(true);
    const cmd = next.hooks?.beforeSubmitPrompt?.[0] as { command: string };
    expect(cmd.command).toContain("/new/path/bm-pilot");
  });

  test("removeBematistHooks strips only our entries", () => {
    const merged = mergeHooks(
      { hooks: { beforeSubmitPrompt: [{ command: "keep-me", source: "user" }] } },
      binaryPath,
    ).next;
    const { next, changed } = removeBematistHooks(merged);
    expect(changed).toBe(true);
    const list = next.hooks?.beforeSubmitPrompt ?? [];
    expect(list).toHaveLength(1);
    expect((list[0] as { source?: string }).source).toBe("user");
  });

  test("quotes binary path with spaces in the command string", () => {
    const entry = buildBematistEntry("/Users/me/Library/bin/bm-pilot app/bm-pilot", "sessionStart");
    expect(entry.command).toBe(
      '"/Users/me/Library/bin/bm-pilot app/bm-pilot" cursor-hook sessionStart',
    );
  });
});

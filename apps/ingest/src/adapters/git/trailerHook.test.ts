import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_KEY,
  buildPrepareCommitMsgScript,
  disableTrailerHook,
  enableTrailerHook,
  resolvePaths,
  statusTrailerHook,
  type TrailerHookRunner,
} from "./trailerHook";

interface TestContext {
  stateDir: string;
  paths: ReturnType<typeof resolvePaths>;
  runner: TrailerHookRunner & { value: string | null; setCalls: string[]; unsetCalls: number };
}

function makeRunner(initial: string | null = null): TestContext["runner"] {
  const r: TestContext["runner"] = {
    value: initial,
    setCalls: [],
    unsetCalls: 0,
    async getGlobalHooksPath() {
      return r.value;
    },
    async setGlobalHooksPath(path: string) {
      r.value = path;
      r.setCalls.push(path);
    },
    async unsetGlobalHooksPath() {
      r.value = null;
      r.unsetCalls++;
    },
  };
  return r;
}

async function fresh(): Promise<TestContext> {
  const stateDir = join(tmpdir(), `bematist-trailer-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true });
  const paths = resolvePaths({ stateDir });
  return { stateDir, paths, runner: makeRunner() };
}

let ctx: TestContext;

beforeEach(async () => {
  ctx = await fresh();
});

afterEach(async () => {
  await rm(ctx.stateDir, { recursive: true, force: true }).catch(() => {});
});

describe("enableTrailerHook", () => {
  test("sets core.hooksPath, writes an executable prepare-commit-msg, backs up no prior value", async () => {
    const r = await enableTrailerHook({ paths: { stateDir: ctx.stateDir }, runner: ctx.runner });
    expect(r.enabled).toBe(true);
    expect(r.previousHooksPath).toBeNull();
    expect(r.backupRecorded).toBe(true);
    expect(ctx.runner.value).toBe(ctx.paths.hookDir);
    expect(ctx.runner.setCalls).toEqual([ctx.paths.hookDir]);

    const st = await stat(ctx.paths.hookScript);
    // POSIX: owner-exec bit present
    expect(st.mode & 0o100).toBe(0o100);
    const script = await readFile(ctx.paths.hookScript, "utf8");
    expect(script).toContain("#!/bin/sh");
    expect(script).toContain("Bematist-Session");
    expect(script).toContain(ctx.paths.sessionFile);

    const cfg = JSON.parse(await readFile(ctx.paths.configPath, "utf8"));
    expect(cfg[BACKUP_KEY]).toBeNull();
  });

  test("backs up a prior core.hooksPath value on first enable", async () => {
    ctx.runner.value = "/home/alice/husky/_";
    const r = await enableTrailerHook({ paths: { stateDir: ctx.stateDir }, runner: ctx.runner });
    expect(r.previousHooksPath).toBe("/home/alice/husky/_");
    expect(ctx.runner.value).toBe(ctx.paths.hookDir);
    const cfg = JSON.parse(await readFile(ctx.paths.configPath, "utf8"));
    expect(cfg[BACKUP_KEY]).toBe("/home/alice/husky/_");
  });

  test("re-enable is idempotent and does not stomp the original backup", async () => {
    ctx.runner.value = "/home/alice/husky/_";
    await enableTrailerHook({ paths: { stateDir: ctx.stateDir }, runner: ctx.runner });
    const setsBefore = ctx.runner.setCalls.length;
    // Second call — runner is already pointing at ours.
    const second = await enableTrailerHook({
      paths: { stateDir: ctx.stateDir },
      runner: ctx.runner,
    });
    expect(second.enabled).toBe(true);
    expect(second.previousHooksPath).toBe("/home/alice/husky/_");
    // No additional git config set call on re-enable.
    expect(ctx.runner.setCalls.length).toBe(setsBefore);
    const cfg = JSON.parse(await readFile(ctx.paths.configPath, "utf8"));
    expect(cfg[BACKUP_KEY]).toBe("/home/alice/husky/_");
  });
});

describe("disableTrailerHook", () => {
  test("restores the original core.hooksPath", async () => {
    ctx.runner.value = "/home/alice/husky/_";
    await enableTrailerHook({ paths: { stateDir: ctx.stateDir }, runner: ctx.runner });
    const r = await disableTrailerHook({ paths: { stateDir: ctx.stateDir }, runner: ctx.runner });
    expect(r.enabled).toBe(false);
    expect(r.restoredHooksPath).toBe("/home/alice/husky/_");
    expect(ctx.runner.value).toBe("/home/alice/husky/_");
    const cfg = JSON.parse(await readFile(ctx.paths.configPath, "utf8"));
    expect(BACKUP_KEY in cfg).toBe(false);
  });

  test("unsets core.hooksPath when there was no prior value", async () => {
    await enableTrailerHook({ paths: { stateDir: ctx.stateDir }, runner: ctx.runner });
    const r = await disableTrailerHook({ paths: { stateDir: ctx.stateDir }, runner: ctx.runner });
    expect(r.restoredHooksPath).toBeNull();
    expect(ctx.runner.value).toBeNull();
    expect(ctx.runner.unsetCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("statusTrailerHook", () => {
  test("reports installed=false before enable", async () => {
    const s = await statusTrailerHook({ paths: { stateDir: ctx.stateDir }, runner: ctx.runner });
    expect(s.installed).toBe(false);
    expect(s.hookScriptExists).toBe(false);
    expect(s.activeSessionId).toBeNull();
  });

  test("reports installed=true + hookScriptExists=true + surfaces active session id after enable", async () => {
    await enableTrailerHook({ paths: { stateDir: ctx.stateDir }, runner: ctx.runner });
    const sessionId = "11111111-2222-4333-8444-555555555555";
    await writeFile(ctx.paths.sessionFile, `${sessionId}\n`);
    const s = await statusTrailerHook({ paths: { stateDir: ctx.stateDir }, runner: ctx.runner });
    expect(s.installed).toBe(true);
    expect(s.hookScriptExists).toBe(true);
    expect(s.activeSessionId).toBe(sessionId);
    expect(s.expectedHooksPath).toBe(ctx.paths.hookDir);
  });
});

describe("prepare-commit-msg script", () => {
  test("appends the Bematist-Session trailer when session file exists", async () => {
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const dir = ctx.stateDir;
    const scriptPath = join(dir, "prepare-commit-msg.sh");
    const sessionFile = join(dir, "current-session");
    await writeFile(sessionFile, `${sessionId}\n`);
    const msgFile = join(dir, "COMMIT_EDITMSG");
    await writeFile(msgFile, "initial commit message\n");

    const script = buildPrepareCommitMsgScript(sessionFile);
    await writeFile(scriptPath, script, { mode: 0o755 });

    const res = Bun.spawn({ cmd: ["sh", scriptPath, msgFile] });
    const code = await res.exited;
    expect(code).toBe(0);

    const final = await readFile(msgFile, "utf8");
    expect(final).toContain(`Bematist-Session: ${sessionId}`);
  });

  test("is idempotent — running twice does not add a duplicate trailer", async () => {
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const dir = ctx.stateDir;
    const scriptPath = join(dir, "prepare-commit-msg.sh");
    const sessionFile = join(dir, "current-session");
    await writeFile(sessionFile, `${sessionId}\n`);
    const msgFile = join(dir, "COMMIT_EDITMSG");
    await writeFile(msgFile, "initial commit message\n");
    await writeFile(scriptPath, buildPrepareCommitMsgScript(sessionFile), { mode: 0o755 });

    await (await Bun.spawn({ cmd: ["sh", scriptPath, msgFile] })).exited;
    await (await Bun.spawn({ cmd: ["sh", scriptPath, msgFile] })).exited;

    const final = await readFile(msgFile, "utf8");
    const count = (final.match(/Bematist-Session:/g) ?? []).length;
    expect(count).toBe(1);
  });

  test("is a no-op when current-session file is missing", async () => {
    const dir = ctx.stateDir;
    const scriptPath = join(dir, "prepare-commit-msg.sh");
    const sessionFile = join(dir, "current-session");
    const msgFile = join(dir, "COMMIT_EDITMSG");
    await writeFile(msgFile, "initial commit message\n");
    await writeFile(scriptPath, buildPrepareCommitMsgScript(sessionFile), { mode: 0o755 });

    const p = Bun.spawn({ cmd: ["sh", scriptPath, msgFile] });
    const code = await p.exited;
    expect(code).toBe(0);
    const final = await readFile(msgFile, "utf8");
    expect(final).toBe("initial commit message\n");
  });
});

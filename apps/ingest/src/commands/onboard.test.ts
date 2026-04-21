import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshConfig, writeConfig } from "../config";
import { runOnboard } from "./onboard";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bm-pilot-onboard-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("runOnboard", () => {
  it("refuses when no config exists", async () => {
    const cfgPath = join(tmp, "config.json");
    const res = await runOnboard({
      configPath: cfgPath,
      home: tmp,
      platform: "linux",
      env: {},
      binaryPath: "/usr/local/bin/bm-pilot",
      installers: stubInstallers(),
      log: () => {},
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-config");
  });

  it("refuses when not logged in", async () => {
    const cfgPath = join(tmp, "config.json");
    await writeConfig(freshConfig("http://localhost:8000"), cfgPath);
    const res = await runOnboard({
      configPath: cfgPath,
      home: tmp,
      platform: "linux",
      env: {},
      binaryPath: "/usr/local/bin/bm-pilot",
      installers: stubInstallers(),
      log: () => {},
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not-logged-in");
  });

  it("enables detected adapters and installs their hooks", async () => {
    const cfgPath = join(tmp, "config.json");
    await seedLoggedInConfig(cfgPath);
    await mkdir(join(tmp, ".claude"), { recursive: true });
    await mkdir(join(tmp, ".codex"), { recursive: true });
    await mkdir(join(tmp, ".cursor"), { recursive: true });

    const installers = stubInstallers();
    const res = await runOnboard({
      configPath: cfgPath,
      home: tmp,
      platform: "linux",
      env: {},
      binaryPath: "/usr/local/bin/bm-pilot",
      installers,
      log: () => {},
    });

    expect(res.ok).toBe(true);
    expect(installers.claudeCodeCalls).toBe(1);
    expect(installers.codexCalls).toBe(1);
    expect(installers.cursorCalls).toBe(1);
    expect(installers.gitTrailerCalls).toBe(1);

    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    expect(cfg.adapters["claude-code"].enabled).toBe(true);
    expect(cfg.adapters.codex.enabled).toBe(true);
    expect(cfg.adapters.cursor.enabled).toBe(true);
  });

  it("skips adapters not detected", async () => {
    const cfgPath = join(tmp, "config.json");
    await seedLoggedInConfig(cfgPath);
    await mkdir(join(tmp, ".claude"), { recursive: true });

    const installers = stubInstallers();
    const res = await runOnboard({
      configPath: cfgPath,
      home: tmp,
      platform: "linux",
      env: {},
      binaryPath: "/usr/local/bin/bm-pilot",
      installers,
      log: () => {},
    });

    expect(res.ok).toBe(true);
    expect(installers.claudeCodeCalls).toBe(1);
    expect(installers.codexCalls).toBe(0);
    expect(installers.cursorCalls).toBe(0);
    expect(installers.gitTrailerCalls).toBe(1);

    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    expect(cfg.adapters["claude-code"].enabled).toBe(true);
    expect(cfg.adapters.codex).toBeUndefined();
    expect(cfg.adapters.cursor).toBeUndefined();
  });

  it("migrates legacy mock:enabled=true config and writes a .bak snapshot", async () => {
    const cfgPath = join(tmp, "config.json");
    // Build a legacy config by writing directly (freshConfig is now {} but old installs had mock).
    const fresh = freshConfig("http://localhost:8000");
    const legacy = {
      ...fresh,
      ingestKey: validKey(),
      adapters: { mock: { enabled: true } },
    };
    await writeConfig(legacy, cfgPath);

    const installers = stubInstallers();
    const res = await runOnboard({
      configPath: cfgPath,
      home: tmp,
      platform: "linux",
      env: {},
      binaryPath: "/usr/local/bin/bm-pilot",
      installers,
      log: () => {},
    });

    expect(res.ok).toBe(true);
    expect(res.migrated).toBe(true);
    const bak = await readFile(`${cfgPath}.bak-pre-ws20`, "utf8");
    expect(JSON.parse(bak).adapters.mock.enabled).toBe(true);

    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    expect(cfg.adapters.mock?.enabled ?? false).toBe(false);
  });

  it("continues when a hook installer fails and records warning", async () => {
    const cfgPath = join(tmp, "config.json");
    await seedLoggedInConfig(cfgPath);
    await mkdir(join(tmp, ".claude"), { recursive: true });
    await mkdir(join(tmp, ".codex"), { recursive: true });

    const installers = stubInstallers();
    installers.claudeCodeImpl = async () => {
      throw new Error("permission denied");
    };

    const res = await runOnboard({
      configPath: cfgPath,
      home: tmp,
      platform: "linux",
      env: {},
      binaryPath: "/usr/local/bin/bm-pilot",
      installers,
      log: () => {},
    });

    expect(res.ok).toBe(true);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.warnings[0]).toMatch(/claude-code/);
    expect(installers.codexCalls).toBe(1);
  });

  it("is idempotent when rerun (no extra .bak files)", async () => {
    const cfgPath = join(tmp, "config.json");
    await seedLoggedInConfig(cfgPath);
    await mkdir(join(tmp, ".claude"), { recursive: true });

    const installers = stubInstallers();
    await runOnboard({
      configPath: cfgPath,
      home: tmp,
      platform: "linux",
      env: {},
      binaryPath: "/usr/local/bin/bm-pilot",
      installers,
      log: () => {},
    });

    const res = await runOnboard({
      configPath: cfgPath,
      home: tmp,
      platform: "linux",
      env: {},
      binaryPath: "/usr/local/bin/bm-pilot",
      installers,
      log: () => {},
    });

    expect(res.ok).toBe(true);
    expect(res.migrated).toBe(false);
    let bakExists = true;
    try {
      await readFile(`${cfgPath}.bak-pre-ws20`, "utf8");
    } catch {
      bakExists = false;
    }
    // No migration happened on re-run (no mock was present), so no bak written.
    expect(bakExists).toBe(false);
  });
});

function validKey(): string {
  return `bm_01234567-89ab-cdef-0123-456789abcdef_keyId012_${"a".repeat(32)}`;
}

async function seedLoggedInConfig(cfgPath: string): Promise<void> {
  const c = freshConfig("http://localhost:8000");
  await writeConfig({ ...c, ingestKey: validKey() }, cfgPath);
}

interface StubInstallers {
  claudeCodeCalls: number;
  codexCalls: number;
  cursorCalls: number;
  gitTrailerCalls: number;
  claudeCodeImpl: () => Promise<void>;
  codexImpl: () => Promise<void>;
  cursorImpl: () => Promise<void>;
  gitTrailerImpl: () => Promise<void>;
  installClaudeCode(): Promise<void>;
  installCodex(): Promise<void>;
  installCursor(): Promise<void>;
  installGitTrailer(): Promise<void>;
}

function stubInstallers(): StubInstallers {
  const s: StubInstallers = {
    claudeCodeCalls: 0,
    codexCalls: 0,
    cursorCalls: 0,
    gitTrailerCalls: 0,
    claudeCodeImpl: async () => {},
    codexImpl: async () => {},
    cursorImpl: async () => {},
    gitTrailerImpl: async () => {},
    async installClaudeCode() {
      s.claudeCodeCalls++;
      await s.claudeCodeImpl();
    },
    async installCodex() {
      s.codexCalls++;
      await s.codexImpl();
    },
    async installCursor() {
      s.cursorCalls++;
      await s.cursorImpl();
    },
    async installGitTrailer() {
      s.gitTrailerCalls++;
      await s.gitTrailerImpl();
    },
  };
  return s;
}

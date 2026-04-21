import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTools, hasClaudeCode, hasCodex, hasCursor } from "./detect";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bm-pilot-detect-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("hasClaudeCode", () => {
  it("returns true when ~/.claude/ exists", async () => {
    await mkdir(join(tmp, ".claude"), { recursive: true });
    expect(hasClaudeCode({ home: tmp })).toBe(true);
  });

  it("returns false when ~/.claude/ absent", () => {
    expect(hasClaudeCode({ home: tmp })).toBe(false);
  });
});

describe("hasCodex", () => {
  it("returns true when ~/.codex/ exists", async () => {
    await mkdir(join(tmp, ".codex"), { recursive: true });
    expect(hasCodex({ home: tmp, env: {} })).toBe(true);
  });

  it("returns true when $CODEX_HOME points at a real dir", async () => {
    const custom = join(tmp, "custom-codex");
    await mkdir(custom, { recursive: true });
    expect(hasCodex({ home: tmp, env: { CODEX_HOME: custom } })).toBe(true);
  });

  it("returns false when neither ~/.codex/ nor $CODEX_HOME exist", () => {
    expect(hasCodex({ home: tmp, env: {} })).toBe(false);
  });

  it("returns false when $CODEX_HOME points at a nonexistent path", () => {
    expect(hasCodex({ home: tmp, env: { CODEX_HOME: join(tmp, "missing") } })).toBe(false);
  });
});

describe("hasCursor", () => {
  it("macOS: returns true when ~/Library/Application Support/Cursor exists", async () => {
    const p = join(tmp, "Library", "Application Support", "Cursor");
    await mkdir(p, { recursive: true });
    expect(hasCursor({ home: tmp, platform: "darwin", env: {} })).toBe(true);
  });

  it("linux: returns true when ~/.config/Cursor exists", async () => {
    await mkdir(join(tmp, ".config", "Cursor"), { recursive: true });
    expect(hasCursor({ home: tmp, platform: "linux", env: {} })).toBe(true);
  });

  it("windows: returns true when %APPDATA%/Cursor exists", async () => {
    const appdata = join(tmp, "AppData", "Roaming");
    await mkdir(join(appdata, "Cursor"), { recursive: true });
    expect(hasCursor({ home: tmp, platform: "win32", env: { APPDATA: appdata } })).toBe(true);
  });

  it("returns true as fallback when ~/.cursor/ exists on any platform", async () => {
    await mkdir(join(tmp, ".cursor"), { recursive: true });
    expect(hasCursor({ home: tmp, platform: "linux", env: {} })).toBe(true);
  });

  it("returns false when no cursor dir is present", () => {
    expect(hasCursor({ home: tmp, platform: "darwin", env: {} })).toBe(false);
  });
});

describe("detectTools", () => {
  it("reports all three as false on a clean home", () => {
    const res = detectTools({ home: tmp, platform: "linux", env: {} });
    expect(res.claudeCode).toBe(false);
    expect(res.codex).toBe(false);
    expect(res.cursor).toBe(false);
  });

  it("reports each flag independently when its dir exists", async () => {
    await mkdir(join(tmp, ".claude"), { recursive: true });
    await mkdir(join(tmp, ".codex"), { recursive: true });
    await mkdir(join(tmp, ".config", "Cursor"), { recursive: true });
    const res = detectTools({ home: tmp, platform: "linux", env: {} });
    expect(res.claudeCode).toBe(true);
    expect(res.codex).toBe(true);
    expect(res.cursor).toBe(true);
  });
});

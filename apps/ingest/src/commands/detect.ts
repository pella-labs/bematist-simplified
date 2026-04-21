import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DetectionOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

export interface DetectionResult {
  claudeCode: boolean;
  codex: boolean;
  cursor: boolean;
}

export function hasClaudeCode(opts: DetectionOptions = {}): boolean {
  const home = opts.home ?? homedir();
  return isDir(join(home, ".claude"));
}

export function hasCodex(opts: DetectionOptions = {}): boolean {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const custom = env.CODEX_HOME;
  if (custom && isDir(custom)) return true;
  return isDir(join(home, ".codex"));
}

export function hasCursor(opts: DetectionOptions = {}): boolean {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;

  if (isDir(join(home, ".cursor"))) return true;

  if (platform === "darwin") {
    return isDir(join(home, "Library", "Application Support", "Cursor"));
  }
  if (platform === "win32") {
    const appdata = env.APPDATA;
    if (appdata && isDir(join(appdata, "Cursor"))) return true;
    return false;
  }
  return isDir(join(home, ".config", "Cursor"));
}

export function detectTools(opts: DetectionOptions = {}): DetectionResult {
  return {
    claudeCode: hasClaudeCode(opts),
    codex: hasCodex(opts),
    cursor: hasCursor(opts),
  };
}

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

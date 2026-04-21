import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { installClaudeSessionStartHook } from "../adapters/claude-code/installHook";
import { installCodexHook } from "../adapters/codex/installHook";
import { installHooks as installCursorHooks } from "../adapters/cursor/installHooks";
import { enableTrailerHook } from "../adapters/git/trailerHook";
import { type Config, readConfig, writeConfig } from "../config";
import { type DetectionResult, detectTools } from "./detect";

export interface OnboardInstallers {
  installClaudeCode(ctx: OnboardContext): Promise<void>;
  installCodex(ctx: OnboardContext): Promise<void>;
  installCursor(ctx: OnboardContext): Promise<void>;
  installGitTrailer(ctx: OnboardContext): Promise<void>;
}

export interface OnboardContext {
  home: string;
  platform: NodeJS.Platform;
  binaryPath: string;
  settingsPath?: string;
  cursorHooksPath?: string;
}

export interface OnboardOptions {
  configPath?: string;
  home?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  binaryPath: string;
  installers?: Partial<OnboardInstallers>;
  log?: (msg: string) => void;
}

export type OnboardReason = "no-config" | "not-logged-in" | "ok";

export interface OnboardResult {
  ok: boolean;
  reason: OnboardReason;
  detected: DetectionResult;
  migrated: boolean;
  warnings: string[];
  enabled: string[];
}

export async function runOnboard(opts: OnboardOptions): Promise<OnboardResult> {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});

  const detected: DetectionResult = { claudeCode: false, codex: false, cursor: false };

  const current = await readConfig(opts.configPath);
  if (!current) {
    return {
      ok: false,
      reason: "no-config",
      detected,
      migrated: false,
      warnings: [],
      enabled: [],
    };
  }
  if (!current.ingestKey) {
    return {
      ok: false,
      reason: "not-logged-in",
      detected,
      migrated: false,
      warnings: [],
      enabled: [],
    };
  }

  const tools = detectTools({ home, platform, env });
  Object.assign(detected, tools);

  const warnings: string[] = [];
  const ctx: OnboardContext = {
    home,
    platform,
    binaryPath: opts.binaryPath,
  };
  const installers = resolveInstallers(opts.installers);

  let migrated = false;
  const hadMock = Boolean(current.adapters.mock?.enabled);
  if (hadMock && opts.configPath) {
    try {
      await mkdir(dirname(opts.configPath), { recursive: true });
      await copyFile(opts.configPath, `${opts.configPath}.bak-pre-ws20`);
      migrated = true;
    } catch (err) {
      warnings.push(`config backup failed: ${errMessage(err)}`);
    }
  }

  const enabled: string[] = [];

  if (tools.claudeCode) {
    try {
      await installers.installClaudeCode(ctx);
      enabled.push("claude-code");
    } catch (err) {
      warnings.push(`claude-code hook install failed: ${errMessage(err)}`);
      log(`[onboard] claude-code: ${errMessage(err)}`);
    }
  }
  if (tools.codex) {
    try {
      await installers.installCodex(ctx);
      enabled.push("codex");
    } catch (err) {
      warnings.push(`codex hook install failed: ${errMessage(err)}`);
      log(`[onboard] codex: ${errMessage(err)}`);
    }
  }
  if (tools.cursor) {
    try {
      await installers.installCursor(ctx);
      enabled.push("cursor");
    } catch (err) {
      warnings.push(`cursor hook install failed: ${errMessage(err)}`);
      log(`[onboard] cursor: ${errMessage(err)}`);
    }
  }

  try {
    await installers.installGitTrailer(ctx);
  } catch (err) {
    warnings.push(`git trailer hook install failed: ${errMessage(err)}`);
    log(`[onboard] git-trailer: ${errMessage(err)}`);
  }

  const next: Config = { ...current, adapters: { ...current.adapters } };
  if (hadMock) next.adapters.mock = { enabled: false };
  if (enabled.includes("claude-code")) next.adapters["claude-code"] = { enabled: true };
  if (enabled.includes("codex")) next.adapters.codex = { enabled: true };
  if (enabled.includes("cursor"))
    next.adapters.cursor = { ...(next.adapters.cursor ?? {}), enabled: true };

  if (opts.configPath) {
    await writeConfig(next, opts.configPath);
  } else {
    await writeConfig(next);
  }

  return {
    ok: true,
    reason: "ok",
    detected: tools,
    migrated,
    warnings,
    enabled,
  };
}

function resolveInstallers(overrides: Partial<OnboardInstallers> = {}): OnboardInstallers {
  return {
    installClaudeCode:
      overrides.installClaudeCode ??
      (async (ctx) => {
        await installClaudeSessionStartHook({
          settingsPath: ctx.settingsPath,
          command: `${ctx.binaryPath} capture-git-sha`,
        });
      }),
    installCodex:
      overrides.installCodex ??
      (async (ctx) => {
        await installCodexHook({
          home: ctx.home,
          platform: ctx.platform,
          binaryPath: ctx.binaryPath,
        });
      }),
    installCursor:
      overrides.installCursor ??
      (async (ctx) => {
        await installCursorHooks({
          binaryPath: ctx.binaryPath,
          hooksPath: ctx.cursorHooksPath,
        });
      }),
    installGitTrailer:
      overrides.installGitTrailer ??
      (async () => {
        await enableTrailerHook();
      }),
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

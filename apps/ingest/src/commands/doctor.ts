import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultSettingsPath, HOOK_EVENT } from "../adapters/claude-code/installHook";
import { HOOK_MARKER as CODEX_HOOK_MARKER } from "../adapters/codex/installHook";
import { defaultCursorHooksPath } from "../adapters/cursor/installHooks";
import { defaultTrailerHookPaths } from "../adapters/git/trailerHook";
import { validateIngestKey } from "../auth";
import { type Config, defaultConfigPath, readConfig } from "../config";
import { detectTools } from "./detect";
import type { ServiceStatusResult } from "./service";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  critical: boolean;
  message: string;
}

export interface DoctorResult {
  exitCode: number;
  checks: DoctorCheck[];
  output: string;
}

export interface DoctorOptions {
  configPath?: string;
  home?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  serviceStatus?: () => Promise<ServiceStatusResult>;
  jsonOutput?: boolean;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorResult> {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const svcStatus =
    opts.serviceStatus ??
    (async () =>
      ({
        platform,
        installed: false,
        running: false,
        pid: null,
        uptimeSec: null,
      }) satisfies ServiceStatusResult);

  const checks: DoctorCheck[] = [];

  let cfg: Config | null = null;
  try {
    cfg = await readConfig(opts.configPath ?? defaultConfigPath(home));
    if (!cfg) {
      checks.push({
        name: "config",
        ok: false,
        critical: true,
        message: "no config found — run `bm-pilot login <token>`",
      });
    } else {
      checks.push({
        name: "config",
        ok: true,
        critical: true,
        message: `apiUrl=${cfg.apiUrl} deviceId=${cfg.deviceId}`,
      });
    }
  } catch (err) {
    checks.push({
      name: "config",
      ok: false,
      critical: true,
      message: `config load failed: ${errMessage(err)}`,
    });
  }

  if (cfg) {
    if (!cfg.ingestKey) {
      checks.push({
        name: "token-format",
        ok: false,
        critical: true,
        message: "no ingest key — run `bm-pilot login <token>`",
      });
    } else {
      try {
        validateIngestKey(cfg.ingestKey);
        checks.push({
          name: "token-format",
          ok: true,
          critical: true,
          message: "ingest key format valid",
        });
      } catch (err) {
        checks.push({
          name: "token-format",
          ok: false,
          critical: true,
          message: errMessage(err),
        });
      }
    }

    const apiOk = await probeApi(cfg.apiUrl, fetchFn);
    checks.push({
      name: "api-reachable",
      ok: apiOk.ok,
      critical: true,
      message: apiOk.message,
    });
  }

  const tools = detectTools({ home, platform, env });
  checks.push({
    name: "detected-tools",
    ok: true,
    critical: false,
    message: `claudeCode=${tools.claudeCode} codex=${tools.codex} cursor=${tools.cursor}`,
  });

  const hookStates = resolveHookStates({ home, platform, env });
  for (const [name, state] of Object.entries(hookStates)) {
    checks.push({
      name: `hook:${name}`,
      ok: state.ok,
      critical: false,
      message: state.message,
    });
  }

  try {
    const svc = await svcStatus();
    checks.push({
      name: "service",
      ok: svc.installed,
      critical: false,
      message: `installed=${svc.installed} running=${svc.running}${svc.pid ? ` pid=${svc.pid}` : ""}`,
    });
    checks.push({
      name: "daemon",
      ok: svc.running,
      critical: false,
      message: svc.running ? `running pid=${svc.pid}` : "not running — run `bm-pilot start`",
    });
  } catch (err) {
    checks.push({
      name: "service",
      ok: false,
      critical: false,
      message: `service status probe failed: ${errMessage(err)}`,
    });
  }

  const exitCode = checks.some((c) => c.critical && !c.ok) ? 1 : 0;
  const output = opts.jsonOutput ? renderJson(checks, exitCode) : renderHuman(checks, exitCode);
  return { exitCode, checks, output };
}

interface HookState {
  ok: boolean;
  message: string;
}

function resolveHookStates(ctx: {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}): Record<string, HookState> {
  const tools = detectTools({ home: ctx.home, platform: ctx.platform, env: ctx.env });
  const out: Record<string, HookState> = {};
  out.claudeCode = tools.claudeCode
    ? checkClaudeCodeHook(defaultSettingsPath(ctx.home))
    : { ok: true, message: "not detected (skipped)" };
  out.codex =
    tools.codex && ctx.platform !== "win32"
      ? checkCodexHook(join(ctx.home, ".codex", "hooks.json"))
      : {
          ok: true,
          message: ctx.platform === "win32" ? "skipped (windows)" : "not detected (skipped)",
        };
  out.cursor = tools.cursor
    ? checkCursorHook(defaultCursorHooksPath(ctx.home))
    : { ok: true, message: "not detected (skipped)" };
  out.gitTrailer = checkGitTrailerHook(defaultTrailerHookPaths(ctx.home).hookScript);
  return out;
}

function checkClaudeCodeHook(path: string): HookState {
  if (!existsSync(path)) return { ok: false, message: `${path} missing` };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    const ev = parsed?.hooks?.[HOOK_EVENT];
    const installed =
      Array.isArray(ev) &&
      ev.some(
        (g: { hooks?: Array<{ command?: string }> }) =>
          Array.isArray(g?.hooks) &&
          g.hooks.some((h) => typeof h?.command === "string" && h.command.includes("bm-pilot")),
      );
    return installed
      ? { ok: true, message: `SessionStart hook present at ${path}` }
      : { ok: false, message: `SessionStart hook not installed at ${path}` };
  } catch (err) {
    return { ok: false, message: `parse failed: ${errMessage(err)}` };
  }
}

function checkCodexHook(path: string): HookState {
  if (!existsSync(path)) return { ok: false, message: `${path} missing` };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    const hooks = Array.isArray(parsed?.hooks) ? parsed.hooks : [];
    const installed = hooks.some(
      (h: { id?: string }) => typeof h?.id === "string" && h.id === CODEX_HOOK_MARKER,
    );
    return installed
      ? { ok: true, message: `SessionStart hook present at ${path}` }
      : { ok: false, message: `SessionStart hook not installed at ${path}` };
  } catch (err) {
    return { ok: false, message: `parse failed: ${errMessage(err)}` };
  }
}

function checkCursorHook(path: string): HookState {
  if (!existsSync(path)) return { ok: false, message: `${path} missing` };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    const hooks = parsed?.hooks ?? {};
    const installed = Object.values(hooks).some(
      (list) =>
        Array.isArray(list) &&
        (list as Array<{ source?: string }>).some((e) => e?.source === "bm-pilot"),
    );
    return installed
      ? { ok: true, message: `cursor hooks present at ${path}` }
      : { ok: false, message: `cursor hooks not installed at ${path}` };
  } catch (err) {
    return { ok: false, message: `parse failed: ${errMessage(err)}` };
  }
}

function checkGitTrailerHook(hookScript: string): HookState {
  return existsSync(hookScript)
    ? { ok: true, message: `trailer hook script at ${hookScript}` }
    : { ok: false, message: `trailer hook script missing (${hookScript})` };
}

async function probeApi(
  apiUrl: string,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<{ ok: boolean; message: string }> {
  const url = `${apiUrl.replace(/\/+$/, "")}/healthz`;
  try {
    const res = await fetchImpl(url, { method: "GET" });
    if (res.ok) return { ok: true, message: `${url} responded ${res.status}` };
    return { ok: false, message: `${url} responded ${res.status}` };
  } catch (err) {
    return { ok: false, message: `${url} unreachable: ${errMessage(err)}` };
  }
}

function renderHuman(checks: DoctorCheck[], exitCode: number): string {
  const lines: string[] = [];
  for (const c of checks) {
    const marker = c.ok ? "[ok]" : c.critical ? "[fail]" : "[warn]";
    lines.push(`${marker.padEnd(6)} ${c.name.padEnd(20)} ${c.message}`);
  }
  lines.push("");
  lines.push(exitCode === 0 ? "doctor: OK" : "doctor: FAIL");
  return lines.join("\n");
}

function renderJson(checks: DoctorCheck[], exitCode: number): string {
  return JSON.stringify({ exitCode, checks }, null, 2);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  HOOK_EVENT as CLAUDE_HOOK_EVENT,
  defaultSettingsPath as defaultClaudeSettingsPath,
} from "./adapters/claude-code/installHook";
import { HOOK_MARKER as CODEX_HOOK_MARKER } from "./adapters/codex/installHook";
import { disableCursor, ensureCursorConsent } from "./adapters/cursor";
import { defaultCursorHooksPath } from "./adapters/cursor/installHooks";
import {
  defaultTrailerHookPaths,
  disableTrailerHook,
  enableTrailerHook,
  statusTrailerHook,
} from "./adapters/git/trailerHook";
import { clearIngestKey, runLoginFlow, validateIngestKey } from "./auth";
import { runCaptureGitShaCli } from "./commands/captureGitSha";
import { runCursorHook } from "./commands/cursorHook";
import { detectTools } from "./commands/detect";
import { runDoctor } from "./commands/doctor";
import { runOnboard } from "./commands/onboard";
import {
  installService,
  resolveDeps,
  serviceStatus,
  startService as startServiceCmd,
  stopService as stopServiceCmd,
  uninstallService,
} from "./commands/service";
import { type Config, defaultConfigPath, freshConfig, readConfig, writeConfig } from "./config";
import { CLIENT_VERSION, startDaemon } from "./daemon";

export interface CliIO {
  argv: string[];
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  env: Record<string, string | undefined>;
  configPath?: string;
  prompt?: (question: string) => Promise<string>;
}

export async function run(io: CliIO): Promise<number> {
  const [, , rawCmd, ...args] = io.argv;
  const cmd = rawCmd ?? "help";
  const path = io.configPath ?? io.env.BM_PILOT_CONFIG ?? defaultConfigPath();
  const log = (msg: string) => io.stdout.write(`${msg}\n`);
  const err = (msg: string) => io.stderr.write(`${msg}\n`);

  switch (cmd) {
    case "help":
    case "-h":
    case "--help":
      log(usage());
      return 0;
    case "version":
    case "-v":
    case "--version":
      log(CLIENT_VERSION);
      return 0;
    case "login":
      return await cmdLogin(io, path, args, log, err);
    case "logout":
      return await cmdLogout(path, log, err);
    case "status":
      return await cmdStatus(io, path, log);
    case "run":
      return await cmdRun(path, args, log, err);
    case "start":
      return await cmdStart(io, path, args, log, err);
    case "stop":
      return await cmdStop(args, log, err);
    case "restart":
      return await cmdRestart(args, log, err);
    case "doctor":
      return await cmdDoctor(io, path, args, log);
    case "uninstall":
      return await cmdUninstall(path, log);
    case "capture-git-sha":
      return await runCaptureGitShaCli();
    case "cursor":
      return await cmdCursor(io, path, args, log, err);
    case "cursor-hook":
      return await runCursorHook({ argv: io.argv, stdin: process.stdin });
    case "git":
      return await cmdGit(args, log, err);
    default:
      err(`unknown command: ${cmd}`);
      err(usage());
      return 2;
  }
}

function usage(): string {
  return [
    "bm-pilot — developer telemetry ingest",
    "",
    "Usage:",
    "  bm-pilot login [token]    Store an ingest key (positional arg skips the prompt)",
    "  bm-pilot start            Auto-detect tools, install hooks, install + start service",
    "  bm-pilot stop [--uninstall]  Stop the service (optionally remove it)",
    "  bm-pilot restart          Stop then start the service (skips re-onboarding)",
    "  bm-pilot status           Print JSON status of config, service, hooks, detected tools",
    "  bm-pilot doctor [--json]  Run diagnostics; exit non-zero on any critical failure",
    "  bm-pilot logout           Clear the stored ingest key",
    "  bm-pilot run              Run the daemon in the foreground (used by the service unit)",
    "  bm-pilot uninstall        Print the removal checklist",
    "  bm-pilot cursor enable    Enable Cursor adapter (prompts for hooks install)",
    "  bm-pilot cursor disable   Disable Cursor adapter (removes hooks entries)",
    "  bm-pilot git enable       Install the global prepare-commit-msg trailer hook",
    "  bm-pilot git disable      Remove the trailer hook + restore prior core.hooksPath",
    "  bm-pilot git status       Report trailer-hook install state",
    "  bm-pilot version          Print the client version",
    "  bm-pilot help             Show this message",
    "",
    "Internal (invoked by editor hooks, not users):",
    "  bm-pilot capture-git-sha  Claude Code / Codex SessionStart hook handler",
    "  bm-pilot cursor-hook      Cursor hook event forwarder",
    "",
    `Config path: ${defaultConfigPath()}`,
  ].join("\n");
}

async function cmdLogin(
  io: CliIO,
  path: string,
  args: string[],
  log: (m: string) => void,
  err: (m: string) => void,
): Promise<number> {
  const positional = args.find((a) => !a.startsWith("-"));
  const current = (await readConfig(path)) ?? freshConfig(io.env.BM_PILOT_API_URL ?? undefined);
  const prompts = {
    async prompt(q: string): Promise<string> {
      if (io.prompt) return io.prompt(q);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(q);
      } finally {
        rl.close();
      }
    },
    print(msg: string) {
      log(msg);
    },
  };
  try {
    const updated = await runLoginFlow(prompts, current, positional ? { token: positional } : {});
    await writeConfig(updated, path);
    log(`logged in — config saved to ${path}`);
    return 0;
  } catch (e) {
    err(`login failed: ${messageOf(e)}`);
    return 1;
  }
}

async function cmdLogout(
  path: string,
  log: (m: string) => void,
  err: (m: string) => void,
): Promise<number> {
  const current = await readConfig(path);
  if (!current) {
    err(`no config found at ${path}`);
    return 1;
  }
  const next = clearIngestKey(current);
  await writeConfig(next, path);
  log(`logged out — ingest key cleared (apiUrl=${next.apiUrl})`);
  return 0;
}

async function cmdStatus(io: CliIO, path: string, log: (m: string) => void): Promise<number> {
  const current = await readConfig(path);
  const status: Record<string, unknown> = {
    configPath: path,
    clientVersion: CLIENT_VERSION,
  };
  if (!current) {
    status.loggedIn = false;
    status.apiUrl = null;
    status.deviceId = null;
    status.adapters = [];
    status.installedAt = null;
  } else {
    status.loggedIn = current.ingestKey !== null;
    status.apiUrl = current.apiUrl;
    status.deviceId = current.deviceId;
    status.adapters = adapterNames(current);
    status.installedAt = current.installedAt;
  }
  status.lastFlushAt = null;

  const home = homedir();
  const detected = detectTools({ home, platform: process.platform, env: io.env });
  status.detectedTools = detected;
  status.hookStates = collectHookStates({ home, platform: process.platform });

  try {
    const deps = resolveDeps({ platform: process.platform, home, env: io.env });
    const svc = await serviceStatus(deps);
    status.serviceInstalled = svc.installed;
    status.daemonRunning = svc.running;
    status.servicePid = svc.pid;
    status.serviceUptimeSec = svc.uptimeSec;
  } catch {
    status.serviceInstalled = false;
    status.daemonRunning = false;
    status.servicePid = null;
    status.serviceUptimeSec = null;
  }

  log(JSON.stringify(status, null, 2));
  return 0;
}

async function cmdRun(
  path: string,
  _args: string[],
  log: (m: string) => void,
  err: (m: string) => void,
): Promise<number> {
  const current = await readConfig(path);
  if (!current?.ingestKey) {
    err("not logged in — run `bm-pilot login <token>` first");
    return 1;
  }
  try {
    const handle = await startDaemon({ config: current, log });
    const stop = async () => {
      await handle.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
    await new Promise<void>(() => {});
    return 0;
  } catch (e) {
    err(`daemon failed: ${messageOf(e)}`);
    return 1;
  }
}

async function cmdStart(
  io: CliIO,
  path: string,
  _args: string[],
  log: (m: string) => void,
  err: (m: string) => void,
): Promise<number> {
  const current = await readConfig(path);
  if (!current) {
    err("no config found — run `bm-pilot login <token>` first");
    return 1;
  }
  if (!current.ingestKey) {
    err("not logged in — run `bm-pilot login <token>` first");
    return 1;
  }
  try {
    validateIngestKey(current.ingestKey);
  } catch (e) {
    err(`invalid ingest key: ${messageOf(e)}`);
    return 1;
  }

  const binaryPath = resolveBinaryPath(io.env);
  const result = await runOnboard({
    configPath: path,
    home: homedir(),
    platform: process.platform,
    env: io.env,
    binaryPath,
    log,
  });

  for (const [tool, present] of Object.entries(result.detected)) {
    log(`${present ? "[ok]" : "[skip]"} detect: ${tool}`);
  }
  for (const w of result.warnings) log(`[warn] ${w}`);
  for (const a of result.enabled) log(`[ok] adapter enabled: ${a}`);

  if (!result.ok) {
    err(`onboarding failed: ${result.reason}`);
    return 1;
  }

  const deps = resolveDeps({
    platform: process.platform,
    home: homedir(),
    env: io.env,
    binaryPath,
  });
  const installRes = await installService(deps);
  if (!installRes.ok) {
    log(`[warn] service install failed: ${installRes.message}`);
    const fallback = await startFallbackDaemon(binaryPath, log);
    if (fallback.ok) {
      log(`[ok] fallback daemon started pid=${fallback.pid}`);
      return 0;
    }
    err(`[fail] fallback daemon failed: ${fallback.message}`);
    return 1;
  }
  log(`[ok] service installed at ${installRes.path ?? "(platform-managed)"}`);

  const startRes = await startServiceCmd(deps);
  if (!startRes.ok) {
    log(`[warn] service start: ${startRes.message}`);
  } else {
    log(`[ok] service started`);
  }
  return 0;
}

async function cmdStop(
  args: string[],
  log: (m: string) => void,
  err: (m: string) => void,
): Promise<number> {
  const uninstall = args.includes("--uninstall");
  const deps = resolveDeps({ platform: process.platform, home: homedir(), env: process.env });
  const stopRes = await stopServiceCmd(deps);
  if (stopRes.ok) log(`[ok] service stopped`);
  else log(`[warn] service stop: ${stopRes.message}`);

  await killFallbackDaemon(log);

  if (uninstall) {
    const unRes = await uninstallService(deps);
    if (unRes.ok) log(`[ok] service uninstalled`);
    else {
      err(`[fail] service uninstall: ${unRes.message}`);
      return 1;
    }
  }
  return 0;
}

async function cmdRestart(
  _args: string[],
  log: (m: string) => void,
  err: (m: string) => void,
): Promise<number> {
  const deps = resolveDeps({ platform: process.platform, home: homedir(), env: process.env });
  const stopRes = await stopServiceCmd(deps);
  if (stopRes.ok) log(`[ok] service stopped`);
  else log(`[warn] service stop: ${stopRes.message}`);
  const startRes = await startServiceCmd(deps);
  if (startRes.ok) {
    log(`[ok] service started`);
    return 0;
  }
  err(`[fail] service start: ${startRes.message}`);
  return 1;
}

async function cmdDoctor(
  io: CliIO,
  path: string,
  args: string[],
  log: (m: string) => void,
): Promise<number> {
  const jsonOutput = args.includes("--json");
  const deps = resolveDeps({ platform: process.platform, home: homedir(), env: io.env });
  const res = await runDoctor({
    configPath: path,
    home: homedir(),
    platform: process.platform,
    env: io.env,
    jsonOutput,
    serviceStatus: () => serviceStatus(deps),
  });
  log(res.output);
  return res.exitCode;
}

async function cmdUninstall(path: string, log: (m: string) => void): Promise<number> {
  log("To fully uninstall bm-pilot:");
  log("  1. Stop the service: `bm-pilot stop --uninstall`");
  log("  2. Remove the binary: rm ~/.local/bin/bm-pilot");
  log(`  3. Remove config + state: rm -rf ${pathParent(path)}`);
  log("  4. Revoke the ingest key in the dashboard");
  return 0;
}

function pathParent(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : p;
}

function adapterNames(c: Config): string[] {
  return Object.entries(c.adapters)
    .filter(([, v]) => v.enabled)
    .map(([k]) => k);
}

async function cmdCursor(
  io: CliIO,
  path: string,
  args: string[],
  log: (m: string) => void,
  err: (m: string) => void,
): Promise<number> {
  const sub = args[0];
  if (!sub || (sub !== "enable" && sub !== "disable")) {
    err("usage: bm-pilot cursor <enable|disable>");
    return 2;
  }
  try {
    if (sub === "enable") {
      const prompts = {
        async prompt(q: string): Promise<string> {
          if (io.prompt) return io.prompt(q);
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return await rl.question(q);
          } finally {
            rl.close();
          }
        },
        print(msg: string) {
          log(msg);
        },
      };
      const res = await ensureCursorConsent({
        configPath: path,
        binaryPath: process.execPath,
        prompts,
      });
      log(JSON.stringify(res, null, 2));
      return 0;
    }
    const res = await disableCursor({ configPath: path });
    log(JSON.stringify(res, null, 2));
    return 0;
  } catch (e) {
    err(`cursor ${sub} failed: ${messageOf(e)}`);
    return 1;
  }
}

async function cmdGit(
  args: string[],
  log: (m: string) => void,
  err: (m: string) => void,
): Promise<number> {
  const sub = args[0];
  if (!sub || (sub !== "enable" && sub !== "disable" && sub !== "status")) {
    err("usage: bm-pilot git <enable|disable|status>");
    return 2;
  }
  try {
    if (sub === "enable") {
      const res = await enableTrailerHook();
      log(JSON.stringify(res, null, 2));
      return 0;
    }
    if (sub === "disable") {
      const res = await disableTrailerHook();
      log(JSON.stringify(res, null, 2));
      return 0;
    }
    const res = await statusTrailerHook();
    log(JSON.stringify(res, null, 2));
    return 0;
  } catch (e) {
    err(`git ${sub} failed: ${messageOf(e)}`);
    return 1;
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function resolveBinaryPath(env: Record<string, string | undefined>): string {
  return env.BM_PILOT_BINARY ?? process.execPath ?? "bm-pilot";
}

interface HookStatesShape {
  claudeCode: boolean;
  codex: boolean;
  cursor: boolean;
  gitTrailer: boolean;
}

function collectHookStates(ctx: { home: string; platform: NodeJS.Platform }): HookStatesShape {
  return {
    claudeCode: isClaudeCodeHookInstalled(defaultClaudeSettingsPath(ctx.home)),
    codex: isCodexHookInstalled(join(ctx.home, ".codex", "hooks.json")),
    cursor: isCursorHookInstalled(defaultCursorHooksPath(ctx.home)),
    gitTrailer: existsSync(defaultTrailerHookPaths(ctx.home).hookScript),
  };
}

function isClaudeCodeHookInstalled(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    const ev = parsed?.hooks?.[CLAUDE_HOOK_EVENT];
    return (
      Array.isArray(ev) &&
      ev.some(
        (g: { hooks?: Array<{ command?: string }> }) =>
          Array.isArray(g?.hooks) &&
          g.hooks.some((h) => typeof h?.command === "string" && h.command.includes("bm-pilot")),
      )
    );
  } catch {
    return false;
  }
}

function isCodexHookInstalled(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    const hooks = Array.isArray(parsed?.hooks) ? parsed.hooks : [];
    return hooks.some((h: { id?: string }) => h?.id === CODEX_HOOK_MARKER);
  } catch {
    return false;
  }
}

function isCursorHookInstalled(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    const hooks = parsed?.hooks ?? {};
    return Object.values(hooks).some(
      (list) =>
        Array.isArray(list) &&
        (list as Array<{ source?: string }>).some((e) => e?.source === "bm-pilot"),
    );
  } catch {
    return false;
  }
}

function fallbackPidPath(): string {
  return join(homedir(), ".bm-pilot", "daemon.pid");
}

async function startFallbackDaemon(
  binaryPath: string,
  log: (m: string) => void,
): Promise<{ ok: boolean; pid: number; message: string }> {
  try {
    const p = Bun.spawn({
      cmd: [binaryPath, "run"],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    const pidPath = fallbackPidPath();
    await mkdir(pidPath.slice(0, pidPath.lastIndexOf("/")), { recursive: true });
    await writeFile(pidPath, String(p.pid));
    log(`[ok] wrote fallback pid to ${pidPath}`);
    return { ok: true, pid: p.pid ?? 0, message: "detached fallback started" };
  } catch (err) {
    return { ok: false, pid: 0, message: messageOf(err) };
  }
}

async function killFallbackDaemon(log: (m: string) => void): Promise<void> {
  const pidPath = fallbackPidPath();
  if (!existsSync(pidPath)) return;
  try {
    const pidText = (await readFile(pidPath, "utf8")).trim();
    const pid = Number.parseInt(pidText, 10);
    if (!Number.isFinite(pid) || pid <= 0) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    await waitForExit(pid, 5000);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    await unlink(pidPath).catch(() => {});
    log(`[ok] stopped fallback daemon pid=${pid}`);
  } catch (err) {
    log(`[warn] fallback kill failed: ${messageOf(err)}`);
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

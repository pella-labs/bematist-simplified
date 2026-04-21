import { createInterface } from "node:readline/promises";
import { disableCursor, ensureCursorConsent } from "./adapters/cursor";
import { clearIngestKey, runLoginFlow } from "./auth";
import { runCaptureGitShaCli } from "./commands/captureGitSha";
import { runCursorHook } from "./commands/cursorHook";
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
  const path = io.configPath ?? io.env.BEMATIST_CONFIG ?? defaultConfigPath();
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
      return await cmdLogin(io, path, log, err);
    case "logout":
      return await cmdLogout(path, log, err);
    case "status":
      return await cmdStatus(path, log);
    case "run":
      return await cmdRun(path, args, log, err);
    case "uninstall":
      return await cmdUninstall(path, log);
    case "capture-git-sha":
      return await runCaptureGitShaCli();
    case "cursor":
      return await cmdCursor(io, path, args, log, err);
    case "cursor-hook":
      return await runCursorHook({ argv: io.argv, stdin: process.stdin });
    default:
      err(`unknown command: ${cmd}`);
      err(usage());
      return 2;
  }
}

function usage(): string {
  return [
    "bematist — developer telemetry ingest",
    "",
    "Usage:",
    "  bematist login            Paste an ingest key to authenticate",
    "  bematist logout           Clear the stored ingest key",
    "  bematist status           Show current configuration",
    "  bematist run              Start the telemetry daemon in foreground",
    "  bematist uninstall        Print the removal checklist",
    "  bematist cursor enable    Enable Cursor adapter (prompts for hooks install)",
    "  bematist cursor disable   Disable Cursor adapter (removes hooks entries)",
    "  bematist version          Print the client version",
    "  bematist help             Show this message",
    "",
    "Internal (invoked by editor hooks, not users):",
    "  bematist capture-git-sha  Claude Code / Codex SessionStart hook handler",
    "  bematist cursor-hook      Cursor hook event forwarder",
    "",
    `Config path: ${defaultConfigPath()}`,
  ].join("\n");
}

async function cmdLogin(
  io: CliIO,
  path: string,
  log: (m: string) => void,
  err: (m: string) => void,
): Promise<number> {
  const current = (await readConfig(path)) ?? freshConfig(io.env.BEMATIST_API_URL ?? undefined);
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
    const updated = await runLoginFlow(prompts, current);
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

async function cmdStatus(path: string, log: (m: string) => void): Promise<number> {
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
    err("not logged in — run `bematist login` first");
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

async function cmdUninstall(path: string, log: (m: string) => void): Promise<number> {
  log("To fully uninstall bematist:");
  log("  1. Stop any running `bematist run` process");
  log("  2. Remove the binary: rm ~/.local/bin/bematist");
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
    err("usage: bematist cursor <enable|disable>");
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

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

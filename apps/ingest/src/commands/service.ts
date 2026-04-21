import { homedir, userInfo } from "node:os";
import {
  installLaunchd,
  startLaunchd,
  statusLaunchd,
  stopLaunchd,
  uninstallLaunchd,
} from "./service/launchd";
import {
  installSystemd,
  startSystemd,
  statusSystemd,
  stopSystemd,
  uninstallSystemd,
} from "./service/systemd";
import {
  installWindows,
  startWindows,
  statusWindows,
  stopWindows,
  uninstallWindows,
} from "./service/windows";

export interface ExecCall {
  cmd: string;
  args: string[];
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

export interface ServiceDeps {
  platform: NodeJS.Platform;
  home: string;
  binaryPath: string;
  stateDir: string;
  env: Record<string, string | undefined>;
  uid: number;
  now: () => Date;
  exec: ExecFn;
}

export interface InstallServiceResult {
  ok: boolean;
  path: string | null;
  fallback: boolean;
  message: string;
}

export interface ServiceStatusResult {
  platform: NodeJS.Platform;
  installed: boolean;
  running: boolean;
  pid: number | null;
  uptimeSec: number | null;
}

export interface SimpleResult {
  ok: boolean;
  message: string;
}

export function resolveDeps(overrides: Partial<ServiceDeps> = {}): ServiceDeps {
  const platform = overrides.platform ?? process.platform;
  const home = overrides.home ?? homedir();
  const env = overrides.env ?? process.env;
  const uid =
    overrides.uid ??
    (() => {
      try {
        return userInfo().uid;
      } catch {
        return 0;
      }
    })();
  return {
    platform,
    home,
    binaryPath: overrides.binaryPath ?? "bm-pilot",
    stateDir: overrides.stateDir ?? `${home}/.bm-pilot`,
    env,
    uid,
    now: overrides.now ?? (() => new Date()),
    exec: overrides.exec ?? defaultExec,
  };
}

export async function installService(deps: ServiceDeps): Promise<InstallServiceResult> {
  try {
    if (deps.platform === "darwin") return await installLaunchd(deps);
    if (deps.platform === "linux") return await installSystemd(deps);
    if (deps.platform === "win32") return await installWindows(deps);
    return {
      ok: false,
      path: null,
      fallback: true,
      message: `unsupported platform: ${deps.platform}`,
    };
  } catch (err) {
    return {
      ok: false,
      path: null,
      fallback: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function startService(deps: ServiceDeps): Promise<SimpleResult> {
  if (deps.platform === "darwin") return startLaunchd(deps);
  if (deps.platform === "linux") return startSystemd(deps);
  if (deps.platform === "win32") return startWindows(deps);
  return { ok: false, message: `unsupported platform: ${deps.platform}` };
}

export async function stopService(deps: ServiceDeps): Promise<SimpleResult> {
  if (deps.platform === "darwin") return stopLaunchd(deps);
  if (deps.platform === "linux") return stopSystemd(deps);
  if (deps.platform === "win32") return stopWindows(deps);
  return { ok: false, message: `unsupported platform: ${deps.platform}` };
}

export async function uninstallService(deps: ServiceDeps): Promise<SimpleResult> {
  if (deps.platform === "darwin") return uninstallLaunchd(deps);
  if (deps.platform === "linux") return uninstallSystemd(deps);
  if (deps.platform === "win32") return uninstallWindows(deps);
  return { ok: false, message: `unsupported platform: ${deps.platform}` };
}

export async function serviceStatus(deps: ServiceDeps): Promise<ServiceStatusResult> {
  if (deps.platform === "darwin") return statusLaunchd(deps);
  if (deps.platform === "linux") return statusSystemd(deps);
  if (deps.platform === "win32") return statusWindows(deps);
  return {
    platform: deps.platform,
    installed: false,
    running: false,
    pid: null,
    uptimeSec: null,
  };
}

const defaultExec: ExecFn = async (cmd, args) => {
  const p = Bun.spawn({
    cmd: [cmd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(p.stdout).text();
  const stderr = await new Response(p.stderr).text();
  const exitCode = await p.exited;
  return { exitCode, stdout, stderr };
};

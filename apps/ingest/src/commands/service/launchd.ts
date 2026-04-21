import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  InstallServiceResult,
  ServiceDeps,
  ServiceStatusResult,
  SimpleResult,
} from "../service";

export const LAUNCHD_LABEL = "com.bm-pilot.agent";
export const PLIST_FILENAME = "com.bm-pilot.agent.plist";

export function plistPath(deps: ServiceDeps): string {
  return join(deps.home, "Library", "LaunchAgents", PLIST_FILENAME);
}

export function renderPlist(deps: ServiceDeps): string {
  const logPath = join(deps.stateDir, "daemon.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${deps.binaryPath}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export async function installLaunchd(deps: ServiceDeps): Promise<InstallServiceResult> {
  const path = plistPath(deps);
  await mkdir(dirname(path), { recursive: true });
  await mkdir(deps.stateDir, { recursive: true });
  await atomicWrite(path, renderPlist(deps), 0o644);

  const target = `gui/${deps.uid}`;
  const alreadyLoaded = await launchctlPrint(deps);
  if (alreadyLoaded) {
    await deps.exec("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`]);
  }
  const boot = await deps.exec("launchctl", ["bootstrap", target, path]);
  if (boot.exitCode !== 0) {
    return {
      ok: false,
      path,
      fallback: true,
      message: `launchctl bootstrap failed: ${boot.stderr.trim() || boot.stdout.trim()}`,
    };
  }
  await deps.exec("launchctl", ["kickstart", "-k", `${target}/${LAUNCHD_LABEL}`]);
  return { ok: true, path, fallback: false, message: "launchd agent installed" };
}

export async function startLaunchd(deps: ServiceDeps): Promise<SimpleResult> {
  const target = `gui/${deps.uid}/${LAUNCHD_LABEL}`;
  const res = await deps.exec("launchctl", ["kickstart", "-k", target]);
  if (res.exitCode !== 0) {
    return {
      ok: false,
      message: `launchctl kickstart failed: ${res.stderr.trim() || res.stdout.trim()}`,
    };
  }
  return { ok: true, message: "launchd agent started" };
}

export async function stopLaunchd(deps: ServiceDeps): Promise<SimpleResult> {
  const target = `gui/${deps.uid}/${LAUNCHD_LABEL}`;
  const res = await deps.exec("launchctl", ["kill", "TERM", target]);
  if (res.exitCode !== 0) {
    return {
      ok: false,
      message: `launchctl kill failed: ${res.stderr.trim() || res.stdout.trim()}`,
    };
  }
  return { ok: true, message: "launchd agent stopped" };
}

export async function uninstallLaunchd(deps: ServiceDeps): Promise<SimpleResult> {
  const path = plistPath(deps);
  const target = `gui/${deps.uid}/${LAUNCHD_LABEL}`;
  await deps.exec("launchctl", ["bootout", target]);
  await unlink(path).catch(() => {});
  return { ok: true, message: "launchd agent uninstalled" };
}

export async function statusLaunchd(deps: ServiceDeps): Promise<ServiceStatusResult> {
  const target = `gui/${deps.uid}/${LAUNCHD_LABEL}`;
  const res = await deps.exec("launchctl", ["print", target]);
  const installed = res.exitCode === 0;
  const { pid, uptimeSec } = parseLaunchctlPrint(res.stdout, deps.now());
  return {
    platform: "darwin",
    installed,
    running: installed && pid !== null,
    pid,
    uptimeSec,
  };
}

async function launchctlPrint(deps: ServiceDeps): Promise<boolean> {
  const res = await deps.exec("launchctl", ["print", `gui/${deps.uid}/${LAUNCHD_LABEL}`]);
  return res.exitCode === 0;
}

function parseLaunchctlPrint(
  stdout: string,
  _now: Date,
): { pid: number | null; uptimeSec: number | null } {
  const match = stdout.match(/pid\s*=\s*(\d+)/);
  if (!match) return { pid: null, uptimeSec: null };
  const pid = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(pid)) return { pid: null, uptimeSec: null };
  return { pid, uptimeSec: null };
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, content, { mode, flag: "w" });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

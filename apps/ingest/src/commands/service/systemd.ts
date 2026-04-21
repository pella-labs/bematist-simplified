import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  InstallServiceResult,
  ServiceDeps,
  ServiceStatusResult,
  SimpleResult,
} from "../service";

export const SYSTEMD_UNIT_NAME = "bm-pilot.service";

export function unitPath(deps: ServiceDeps): string {
  return join(deps.home, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
}

export function renderUnit(deps: ServiceDeps): string {
  const logPath = join(deps.stateDir, "daemon.log");
  return `[Unit]
Description=Bematist telemetry collector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${deps.binaryPath} run
Restart=on-failure
RestartSec=5s
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

export async function installSystemd(deps: ServiceDeps): Promise<InstallServiceResult> {
  const path = unitPath(deps);
  await mkdir(dirname(path), { recursive: true });
  await mkdir(deps.stateDir, { recursive: true });
  await atomicWrite(path, renderUnit(deps), 0o644);

  const reload = await deps.exec("systemctl", ["--user", "daemon-reload"]);
  if (reload.exitCode !== 0) {
    return {
      ok: false,
      path,
      fallback: true,
      message: `systemctl daemon-reload failed: ${reload.stderr.trim() || reload.stdout.trim()}`,
    };
  }
  const enable = await deps.exec("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT_NAME]);
  if (enable.exitCode !== 0) {
    return {
      ok: false,
      path,
      fallback: true,
      message: `systemctl enable failed: ${enable.stderr.trim() || enable.stdout.trim()}`,
    };
  }
  return { ok: true, path, fallback: false, message: "systemd user unit installed" };
}

export async function startSystemd(deps: ServiceDeps): Promise<SimpleResult> {
  const res = await deps.exec("systemctl", ["--user", "start", SYSTEMD_UNIT_NAME]);
  if (res.exitCode !== 0) {
    return {
      ok: false,
      message: `systemctl start failed: ${res.stderr.trim() || res.stdout.trim()}`,
    };
  }
  return { ok: true, message: "systemd unit started" };
}

export async function stopSystemd(deps: ServiceDeps): Promise<SimpleResult> {
  const res = await deps.exec("systemctl", ["--user", "stop", SYSTEMD_UNIT_NAME]);
  if (res.exitCode !== 0) {
    return {
      ok: false,
      message: `systemctl stop failed: ${res.stderr.trim() || res.stdout.trim()}`,
    };
  }
  return { ok: true, message: "systemd unit stopped" };
}

export async function uninstallSystemd(deps: ServiceDeps): Promise<SimpleResult> {
  const disable = await deps.exec("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT_NAME]);
  await unlink(unitPath(deps)).catch(() => {});
  await deps.exec("systemctl", ["--user", "daemon-reload"]);
  if (disable.exitCode !== 0) {
    return {
      ok: false,
      message: `systemctl disable failed: ${disable.stderr.trim() || disable.stdout.trim()}`,
    };
  }
  return { ok: true, message: "systemd user unit removed" };
}

export async function statusSystemd(deps: ServiceDeps): Promise<ServiceStatusResult> {
  const isEnabled = await deps.exec("systemctl", ["--user", "is-enabled", SYSTEMD_UNIT_NAME]);
  const installed = isEnabled.exitCode === 0;
  const show = await deps.exec("systemctl", [
    "--user",
    "show",
    SYSTEMD_UNIT_NAME,
    "--property=MainPID,ActiveState,ActiveEnterTimestampMonotonic",
  ]);
  const { pid, running } = parseShow(show.stdout);
  return {
    platform: "linux",
    installed,
    running,
    pid,
    uptimeSec: null,
  };
}

function parseShow(out: string): { pid: number | null; running: boolean } {
  const pidMatch = out.match(/MainPID=(\d+)/);
  const activeMatch = out.match(/ActiveState=([\w-]+)/);
  const pidNum = pidMatch ? Number.parseInt(pidMatch[1] ?? "0", 10) : 0;
  const pid = pidNum > 0 ? pidNum : null;
  const running = activeMatch?.[1] === "active";
  return { pid, running };
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

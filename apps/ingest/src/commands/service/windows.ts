import type {
  InstallServiceResult,
  ServiceDeps,
  ServiceStatusResult,
  SimpleResult,
} from "../service";

export const WINDOWS_TASK_NAME = "Bematist";

export async function installWindows(deps: ServiceDeps): Promise<InstallServiceResult> {
  const username = deps.env.USERNAME ?? "";
  const args = [
    "/Create",
    "/TN",
    WINDOWS_TASK_NAME,
    "/TR",
    `"${deps.binaryPath}" run`,
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/F",
  ];
  if (username) {
    args.push("/RU", username);
  }
  const res = await deps.exec("schtasks", args);
  if (res.exitCode !== 0) {
    return {
      ok: false,
      path: null,
      fallback: true,
      message: `schtasks /Create failed: ${res.stderr.trim() || res.stdout.trim()}`,
    };
  }
  await deps.exec("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]);
  return { ok: true, path: null, fallback: false, message: "scheduled task registered" };
}

export async function startWindows(deps: ServiceDeps): Promise<SimpleResult> {
  const res = await deps.exec("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]);
  if (res.exitCode !== 0) {
    return {
      ok: false,
      message: `schtasks /Run failed: ${res.stderr.trim() || res.stdout.trim()}`,
    };
  }
  return { ok: true, message: "scheduled task started" };
}

export async function stopWindows(deps: ServiceDeps): Promise<SimpleResult> {
  const res = await deps.exec("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]);
  if (res.exitCode !== 0) {
    return {
      ok: false,
      message: `schtasks /End failed: ${res.stderr.trim() || res.stdout.trim()}`,
    };
  }
  return { ok: true, message: "scheduled task stopped" };
}

export async function uninstallWindows(deps: ServiceDeps): Promise<SimpleResult> {
  const res = await deps.exec("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
  if (res.exitCode !== 0) {
    return {
      ok: false,
      message: `schtasks /Delete failed: ${res.stderr.trim() || res.stdout.trim()}`,
    };
  }
  return { ok: true, message: "scheduled task removed" };
}

export async function statusWindows(deps: ServiceDeps): Promise<ServiceStatusResult> {
  const res = await deps.exec("schtasks", [
    "/Query",
    "/TN",
    WINDOWS_TASK_NAME,
    "/FO",
    "LIST",
    "/V",
  ]);
  const installed = res.exitCode === 0;
  const running = installed && /Status:\s+Running/i.test(res.stdout);
  return {
    platform: "win32",
    installed,
    running,
    pid: null,
    uptimeSec: null,
  };
}

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExecCall,
  installService,
  type ServiceDeps,
  serviceStatus,
  startService,
  stopService,
  uninstallService,
} from "./service";

let tmp: string;
let calls: ExecCall[];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bm-pilot-service-"));
  calls = [];
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeDeps(platform: NodeJS.Platform, exitCode = 0, stdout = ""): ServiceDeps {
  return {
    platform,
    home: tmp,
    binaryPath: "/usr/local/bin/bm-pilot",
    stateDir: join(tmp, ".bm-pilot"),
    env: platform === "win32" ? { USERNAME: "tester" } : { USER: "tester" },
    uid: 501,
    now: () => new Date("2026-04-21T00:00:00Z"),
    exec: async (cmd, args) => {
      calls.push({ cmd, args });
      return { exitCode, stdout, stderr: "" };
    },
  };
}

describe("installService dispatch", () => {
  it("macOS: writes plist to ~/Library/LaunchAgents and calls launchctl bootstrap", async () => {
    const deps = makeDeps("darwin");
    const res = await installService(deps);
    expect(res.ok).toBe(true);
    const plistPath = join(tmp, "Library", "LaunchAgents", "com.bm-pilot.agent.plist");
    expect(res.path).toBe(plistPath);
    const contents = await readFile(plistPath, "utf8");
    expect(contents).toContain("/usr/local/bin/bm-pilot");
    expect(contents).toContain("<string>run</string>");
    const st = await stat(plistPath);
    expect(st.isFile()).toBe(true);
    const bootstrap = calls.find((c) => c.cmd === "launchctl" && c.args[0] === "bootstrap");
    expect(bootstrap).toBeDefined();
    expect(bootstrap?.args).toEqual(["bootstrap", "gui/501", plistPath]);
  });

  it("linux: writes service unit and calls systemctl --user enable --now", async () => {
    const deps = makeDeps("linux");
    const res = await installService(deps);
    expect(res.ok).toBe(true);
    const unitPath = join(tmp, ".config", "systemd", "user", "bm-pilot.service");
    expect(res.path).toBe(unitPath);
    const contents = await readFile(unitPath, "utf8");
    expect(contents).toContain("ExecStart=/usr/local/bin/bm-pilot run");
    const daemonReload = calls.find(
      (c) => c.cmd === "systemctl" && c.args.includes("daemon-reload"),
    );
    expect(daemonReload).toBeDefined();
    const enable = calls.find((c) => c.cmd === "systemctl" && c.args.includes("enable"));
    expect(enable).toBeDefined();
    expect(enable?.args).toEqual(["--user", "enable", "--now", "bm-pilot.service"]);
  });

  it("win32: calls schtasks /Create with ONLOGON trigger", async () => {
    const deps = makeDeps("win32");
    const res = await installService(deps);
    expect(res.ok).toBe(true);
    const create = calls.find((c) => c.cmd === "schtasks" && c.args.includes("/Create"));
    expect(create).toBeDefined();
    expect(create?.args).toContain("/SC");
    expect(create?.args).toContain("ONLOGON");
    expect(create?.args).toContain("/TN");
    const tnIdx = create?.args.indexOf("/TN") ?? -1;
    expect(create?.args[tnIdx + 1]).toBe("Bematist");
  });

  it("returns fallback result when exec fails and no platform backend usable", async () => {
    const deps: ServiceDeps = {
      ...makeDeps("darwin", 1, ""),
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "launchctl not found" }),
    };
    const res = await installService(deps);
    expect(res.ok).toBe(false);
    expect(res.fallback).toBe(true);
  });
});

describe("startService dispatch", () => {
  it("macOS: invokes launchctl kickstart", async () => {
    const deps = makeDeps("darwin");
    await startService(deps);
    const kick = calls.find((c) => c.cmd === "launchctl" && c.args[0] === "kickstart");
    expect(kick).toBeDefined();
    expect(kick?.args).toEqual(["kickstart", "-k", "gui/501/com.bm-pilot.agent"]);
  });

  it("linux: systemctl --user start", async () => {
    const deps = makeDeps("linux");
    await startService(deps);
    const start = calls.find((c) => c.cmd === "systemctl" && c.args.includes("start"));
    expect(start).toBeDefined();
    expect(start?.args).toEqual(["--user", "start", "bm-pilot.service"]);
  });

  it("win32: schtasks /Run", async () => {
    const deps = makeDeps("win32");
    await startService(deps);
    const run = calls.find((c) => c.cmd === "schtasks" && c.args.includes("/Run"));
    expect(run).toBeDefined();
  });
});

describe("stopService dispatch", () => {
  it("macOS: launchctl bootout does NOT run by default (stop is kickstart -k-style)", async () => {
    const deps = makeDeps("darwin");
    await stopService(deps);
    const bootout = calls.find((c) => c.cmd === "launchctl" && c.args[0] === "bootout");
    expect(bootout).toBeUndefined();
  });

  it("linux: systemctl --user stop", async () => {
    const deps = makeDeps("linux");
    await stopService(deps);
    const stop = calls.find((c) => c.cmd === "systemctl" && c.args.includes("stop"));
    expect(stop).toBeDefined();
  });
});

describe("uninstallService dispatch", () => {
  it("macOS: launchctl bootout + removes plist", async () => {
    const deps = makeDeps("darwin");
    await installService(deps);
    calls.length = 0;
    await uninstallService(deps);
    const bootout = calls.find((c) => c.cmd === "launchctl" && c.args[0] === "bootout");
    expect(bootout).toBeDefined();
    const plistPath = join(tmp, "Library", "LaunchAgents", "com.bm-pilot.agent.plist");
    let exists = false;
    try {
      await stat(plistPath);
      exists = true;
    } catch {}
    expect(exists).toBe(false);
  });

  it("linux: systemctl --user disable --now", async () => {
    const deps = makeDeps("linux");
    await installService(deps);
    calls.length = 0;
    await uninstallService(deps);
    const disable = calls.find((c) => c.cmd === "systemctl" && c.args.includes("disable"));
    expect(disable).toBeDefined();
    expect(disable?.args).toEqual(["--user", "disable", "--now", "bm-pilot.service"]);
  });

  it("win32: schtasks /Delete", async () => {
    const deps = makeDeps("win32");
    await uninstallService(deps);
    const del = calls.find((c) => c.cmd === "schtasks" && c.args.includes("/Delete"));
    expect(del).toBeDefined();
  });
});

describe("serviceStatus dispatch", () => {
  it("macOS: launchctl print reports installed when exit code 0", async () => {
    const deps = makeDeps("darwin");
    const res = await serviceStatus(deps);
    expect(res.platform).toBe("darwin");
    const print = calls.find((c) => c.cmd === "launchctl" && c.args.includes("print"));
    expect(print).toBeDefined();
    expect(res.installed).toBe(true);
  });

  it("linux: systemctl --user is-enabled", async () => {
    const deps = makeDeps("linux", 0, "enabled\n");
    const res = await serviceStatus(deps);
    expect(res.installed).toBe(true);
    const q = calls.find((c) => c.cmd === "systemctl" && c.args.includes("is-enabled"));
    expect(q).toBeDefined();
  });

  it("win32: schtasks /Query", async () => {
    const deps = makeDeps("win32");
    await serviceStatus(deps);
    const query = calls.find((c) => c.cmd === "schtasks" && c.args.includes("/Query"));
    expect(query).toBeDefined();
  });
});

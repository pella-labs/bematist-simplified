import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HOOK_SCRIPT_NAME = "prepare-commit-msg";
export const SESSION_FILE_NAME = "current-session";
export const GIT_HOOK_DIR_NAME = "git-hooks";
export const BACKUP_KEY = "gitHooksPathBackup";

export interface TrailerHookPaths {
  /** `~/.bm-pilot` equivalent. Tests override this. */
  stateDir: string;
  /** Path to the prepare-commit-msg script. Derived from stateDir. */
  hookScript: string;
  /** Directory containing the hook script. Derived from stateDir. */
  hookDir: string;
  /** File storing the current active session id. Derived from stateDir. */
  sessionFile: string;
  /** `~/.bm-pilot/config.json` equivalent; we write the backup key there. */
  configPath: string;
}

export interface TrailerHookRunner {
  /** Run `git config --global --get core.hooksPath`. Returns null when unset. */
  getGlobalHooksPath(): Promise<string | null>;
  /** Run `git config --global core.hooksPath <path>`. */
  setGlobalHooksPath(path: string): Promise<void>;
  /** Run `git config --global --unset core.hooksPath`. Tolerant when unset. */
  unsetGlobalHooksPath(): Promise<void>;
}

export interface EnableOptions {
  paths?: Partial<TrailerHookPaths>;
  runner?: TrailerHookRunner;
}

export interface EnableResult {
  enabled: true;
  hookScriptPath: string;
  hookDirPath: string;
  previousHooksPath: string | null;
  backupRecorded: boolean;
}

export interface DisableResult {
  enabled: false;
  restoredHooksPath: string | null;
  backupCleared: boolean;
}

export interface StatusResult {
  installed: boolean;
  currentHooksPath: string | null;
  expectedHooksPath: string;
  hookScriptExists: boolean;
  activeSessionId: string | null;
}

export function defaultTrailerHookPaths(home: string = homedir()): TrailerHookPaths {
  const stateDir = join(home, ".bm-pilot");
  const hookDir = join(stateDir, GIT_HOOK_DIR_NAME);
  return {
    stateDir,
    hookDir,
    hookScript: join(hookDir, HOOK_SCRIPT_NAME),
    sessionFile: join(stateDir, SESSION_FILE_NAME),
    configPath: join(stateDir, "config.json"),
  };
}

export function resolvePaths(overrides: Partial<TrailerHookPaths> = {}): TrailerHookPaths {
  const defaults = defaultTrailerHookPaths();
  const stateDir = overrides.stateDir ?? defaults.stateDir;
  const hookDir = overrides.hookDir ?? join(stateDir, GIT_HOOK_DIR_NAME);
  return {
    stateDir,
    hookDir,
    hookScript: overrides.hookScript ?? join(hookDir, HOOK_SCRIPT_NAME),
    sessionFile: overrides.sessionFile ?? join(stateDir, SESSION_FILE_NAME),
    configPath: overrides.configPath ?? join(stateDir, "config.json"),
  };
}

export function buildPrepareCommitMsgScript(sessionFile: string): string {
  const quoted = shellQuote(sessionFile);
  return `#!/bin/sh
# bm-pilot prepare-commit-msg: append Bematist-Session trailer.
# Never fail the commit — exit 0 on every path.
set -e

msg_file="$1"
if [ -z "$msg_file" ]; then
  exit 0
fi

session_file=${quoted}
if [ ! -f "$session_file" ]; then
  exit 0
fi

session_id=$(cat "$session_file" 2>/dev/null | tr -d '\\n' | tr -d '\\r')
if [ -z "$session_id" ]; then
  exit 0
fi

git interpret-trailers \\
  --trailer "Bematist-Session: $session_id" \\
  --if-exists addIfDifferent \\
  --in-place "$msg_file" >/dev/null 2>&1 || true

exit 0
`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function atomicWrite(path: string, content: string, mode = 0o600): Promise<void> {
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

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch (err) {
    if (isNotFound(err)) return {};
    throw err;
  }
}

async function writeJson(path: string, value: Record<string, unknown>): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeHookScript(paths: TrailerHookPaths): Promise<void> {
  const script = buildPrepareCommitMsgScript(paths.sessionFile);
  await mkdir(paths.hookDir, { recursive: true });
  await atomicWrite(paths.hookScript, script, 0o755);
  // Ensure exec bit even when umask strips it during rename on some filesystems.
  await chmod(paths.hookScript, 0o755);
}

export async function recordBackup(
  paths: TrailerHookPaths,
  previous: string | null,
): Promise<void> {
  const cfg = await readJson(paths.configPath);
  if (previous === null) {
    // Only clear the key if it wasn't already set by a prior partial enable —
    // we never want to stomp a legitimate backup.
    if (!(BACKUP_KEY in cfg)) cfg[BACKUP_KEY] = null;
  } else {
    cfg[BACKUP_KEY] = previous;
  }
  await writeJson(paths.configPath, cfg);
}

export async function readBackup(
  paths: TrailerHookPaths,
): Promise<{ set: boolean; value: string | null }> {
  const cfg = await readJson(paths.configPath);
  if (!(BACKUP_KEY in cfg)) return { set: false, value: null };
  const raw = cfg[BACKUP_KEY];
  if (raw === null) return { set: true, value: null };
  if (typeof raw === "string") return { set: true, value: raw };
  return { set: false, value: null };
}

export async function clearBackup(paths: TrailerHookPaths): Promise<void> {
  const cfg = await readJson(paths.configPath);
  if (BACKUP_KEY in cfg) {
    delete cfg[BACKUP_KEY];
    await writeJson(paths.configPath, cfg);
  }
}

export function createGitRunner(): TrailerHookRunner {
  return {
    async getGlobalHooksPath() {
      const p = Bun.spawn({
        cmd: ["git", "config", "--global", "--get", "core.hooksPath"],
        stdout: "pipe",
        stderr: "ignore",
      });
      const text = await new Response(p.stdout).text();
      const code = await p.exited;
      if (code !== 0) return null;
      const v = text.trim();
      return v.length > 0 ? v : null;
    },
    async setGlobalHooksPath(path: string) {
      const p = Bun.spawn({
        cmd: ["git", "config", "--global", "core.hooksPath", path],
        stdout: "ignore",
        stderr: "pipe",
      });
      const code = await p.exited;
      if (code !== 0) {
        const err = await new Response(p.stderr).text();
        throw new Error(`git config set core.hooksPath failed: ${err.trim()}`);
      }
    },
    async unsetGlobalHooksPath() {
      const p = Bun.spawn({
        cmd: ["git", "config", "--global", "--unset", "core.hooksPath"],
        stdout: "ignore",
        stderr: "ignore",
      });
      // Exit code 5 = variable not set; treat as success.
      await p.exited;
    },
  };
}

export async function enableTrailerHook(opts: EnableOptions = {}): Promise<EnableResult> {
  const paths = resolvePaths(opts.paths);
  const runner = opts.runner ?? createGitRunner();

  const existing = await runner.getGlobalHooksPath();
  const alreadyOurs = existing !== null && existing === paths.hookDir;
  const backup = await readBackup(paths);

  await writeHookScript(paths);

  let previousHooksPath: string | null;
  let backupRecorded = false;

  if (alreadyOurs) {
    // Idempotent re-enable. Don't overwrite the backup.
    previousHooksPath = backup.set ? backup.value : null;
  } else {
    previousHooksPath = existing;
    if (!backup.set) {
      await recordBackup(paths, existing);
      backupRecorded = true;
    } else {
      previousHooksPath = backup.value;
    }
    await runner.setGlobalHooksPath(paths.hookDir);
  }

  return {
    enabled: true,
    hookScriptPath: paths.hookScript,
    hookDirPath: paths.hookDir,
    previousHooksPath,
    backupRecorded,
  };
}

export async function disableTrailerHook(opts: EnableOptions = {}): Promise<DisableResult> {
  const paths = resolvePaths(opts.paths);
  const runner = opts.runner ?? createGitRunner();
  const backup = await readBackup(paths);

  let restored: string | null = null;
  if (backup.set) {
    if (backup.value !== null) {
      await runner.setGlobalHooksPath(backup.value);
      restored = backup.value;
    } else {
      await runner.unsetGlobalHooksPath();
    }
    await clearBackup(paths);
  } else {
    // No backup on record. Safest behavior: only unset if current value is ours.
    const current = await runner.getGlobalHooksPath();
    if (current !== null && current === paths.hookDir) {
      await runner.unsetGlobalHooksPath();
    }
  }

  return {
    enabled: false,
    restoredHooksPath: restored,
    backupCleared: backup.set,
  };
}

export async function statusTrailerHook(opts: EnableOptions = {}): Promise<StatusResult> {
  const paths = resolvePaths(opts.paths);
  const runner = opts.runner ?? createGitRunner();
  const current = await runner.getGlobalHooksPath();
  let hookScriptExists = false;
  try {
    await readFile(paths.hookScript, "utf8");
    hookScriptExists = true;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  let activeSessionId: string | null = null;
  try {
    const raw = await readFile(paths.sessionFile, "utf8");
    const v = raw.trim();
    if (v.length > 0) activeSessionId = v;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  return {
    installed: current !== null && current === paths.hookDir,
    currentHooksPath: current,
    expectedHooksPath: paths.hookDir,
    hookScriptExists,
    activeSessionId,
  };
}

function isNotFound(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT",
  );
}

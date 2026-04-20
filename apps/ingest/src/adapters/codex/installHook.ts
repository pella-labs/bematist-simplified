import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface InstallHookOptions {
  home?: string;
  platform?: NodeJS.Platform;
  binaryPath?: string;
  log?: (msg: string) => void;
  gitShaQueueDir?: string;
}

export interface InstallHookResult {
  status: "installed" | "skipped_windows" | "already_present";
  path: string | null;
}

export const HOOK_MARKER = "bematist-codex-session-start";

export async function installCodexHook(opts: InstallHookOptions = {}): Promise<InstallHookResult> {
  const platform = opts.platform ?? process.platform;
  const log = opts.log ?? defaultLog;
  if (platform === "win32") {
    log("[codex] hook install skipped on Windows");
    return { status: "skipped_windows", path: null };
  }

  const home = opts.home ?? homedir();
  const hooksPath = join(home, ".codex", "hooks.json");
  const queueDir = opts.gitShaQueueDir ?? join(home, ".bematist", "git-sha-queue");
  const binary = opts.binaryPath ?? "bematist";

  await mkdir(dirname(hooksPath), { recursive: true });
  await mkdir(queueDir, { recursive: true });

  const existing = await readJsonIfExists(hooksPath);
  const next = mergeHook(existing, {
    marker: HOOK_MARKER,
    binary,
    queueDir,
  });

  if (next.unchanged) {
    return { status: "already_present", path: hooksPath };
  }

  await atomicWriteJson(hooksPath, next.value);
  return { status: "installed", path: hooksPath };
}

interface HookMergeInput {
  marker: string;
  binary: string;
  queueDir: string;
}

interface HookMergeResult {
  value: Record<string, unknown>;
  unchanged: boolean;
}

export function mergeHook(
  existing: Record<string, unknown> | null,
  input: HookMergeInput,
): HookMergeResult {
  const base: Record<string, unknown> = existing ? { ...existing } : {};
  const hooks = Array.isArray(base.hooks) ? [...(base.hooks as unknown[])] : [];

  const ours = {
    id: input.marker,
    event: "SessionStart",
    command: `${input.binary} capture-git-sha`,
    args: ["--queue", input.queueDir],
  };

  let replaced = false;
  const filtered = hooks.map((h) => {
    if (h && typeof h === "object" && (h as Record<string, unknown>).id === input.marker) {
      replaced = true;
      return ours;
    }
    return h;
  });

  if (!replaced) filtered.push(ours);
  base.hooks = filtered;

  const unchanged =
    replaced && JSON.stringify(existing?.hooks ?? null) === JSON.stringify(filtered);

  return { value: base, unchanged };
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT",
  );
}

function defaultLog(msg: string): void {
  console.log(msg);
}

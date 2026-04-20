import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CURSOR_HOOK_EVENTS, type CursorHookEvent } from "./normalize";

const BEMATIST_MARK = "bematist";

export function defaultCursorHooksPath(home: string = homedir()): string {
  return join(home, ".cursor", "hooks.json");
}

export interface HookEntry {
  command: string;
  [k: string]: unknown;
}

export interface HooksFile {
  hooks?: Partial<Record<CursorHookEvent, HookEntry[]>>;
  [k: string]: unknown;
}

export interface InstallOptions {
  hooksPath?: string;
  binaryPath: string;
  timeoutMs?: number;
}

export interface InstallResult {
  changed: boolean;
  backupCreated: boolean;
  path: string;
}

export async function readHooksFile(path: string): Promise<HooksFile | null> {
  try {
    const raw = await readFile(path, "utf8");
    if (raw.trim().length === 0) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as HooksFile;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export function buildBematistEntry(binaryPath: string, event: CursorHookEvent): HookEntry {
  return {
    command: `${quoteIfNeeded(binaryPath)} cursor-hook ${event}`,
    source: BEMATIST_MARK,
  };
}

export function mergeHooks(
  existing: HooksFile | null,
  binaryPath: string,
): { next: HooksFile; changed: boolean } {
  const base: HooksFile = existing ? { ...existing } : {};
  const currentHooks = (base.hooks ?? {}) as Partial<Record<CursorHookEvent, HookEntry[]>>;
  const nextHooks: Partial<Record<CursorHookEvent, HookEntry[]>> = { ...currentHooks };
  let changed = false;

  for (const event of CURSOR_HOOK_EVENTS) {
    const list = (nextHooks[event] ?? []).slice();
    const ours = buildBematistEntry(binaryPath, event);
    const existingIdx = list.findIndex(
      (e) => typeof e === "object" && e !== null && (e as HookEntry).source === BEMATIST_MARK,
    );
    if (existingIdx === -1) {
      list.push(ours);
      changed = true;
    } else {
      const before = list[existingIdx] as HookEntry;
      if (before.command !== ours.command) {
        list[existingIdx] = ours;
        changed = true;
      }
    }
    nextHooks[event] = list;
  }

  base.hooks = nextHooks;
  return { next: base, changed };
}

export function removeBematistHooks(existing: HooksFile | null): {
  next: HooksFile;
  changed: boolean;
} {
  const base: HooksFile = existing ? { ...existing } : {};
  const currentHooks = (base.hooks ?? {}) as Partial<Record<CursorHookEvent, HookEntry[]>>;
  const nextHooks: Partial<Record<CursorHookEvent, HookEntry[]>> = {};
  let changed = false;
  for (const event of CURSOR_HOOK_EVENTS) {
    const list = currentHooks[event] ?? [];
    const filtered = list.filter(
      (e) => !(typeof e === "object" && e !== null && (e as HookEntry).source === BEMATIST_MARK),
    );
    if (filtered.length !== list.length) changed = true;
    if (filtered.length > 0) nextHooks[event] = filtered;
  }
  base.hooks = nextHooks;
  return { next: base, changed };
}

export async function installHooks(opts: InstallOptions): Promise<InstallResult> {
  const path = opts.hooksPath ?? defaultCursorHooksPath();
  await mkdir(dirname(path), { recursive: true });
  const existing = await readHooksFile(path);
  const { next, changed } = mergeHooks(existing, opts.binaryPath);
  if (!changed) return { changed: false, backupCreated: false, path };

  const backupPath = `${path}.bak`;
  const hadFile = existing !== null;
  let backupCreated = false;
  if (hadFile) {
    try {
      await copyFile(path, backupPath, 1);
      backupCreated = true;
    } catch (err) {
      if (!isExists(err)) throw err;
    }
  }

  await atomicWriteJson(path, next);
  return { changed: true, backupCreated, path };
}

export async function uninstallHooks(opts: {
  hooksPath?: string;
}): Promise<{ changed: boolean; path: string }> {
  const path = opts.hooksPath ?? defaultCursorHooksPath();
  const existing = await readHooksFile(path);
  if (!existing) return { changed: false, path };
  const { next, changed } = removeBematistHooks(existing);
  if (!changed) return { changed: false, path };
  await atomicWriteJson(path, next);
  return { changed: true, path };
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

function quoteIfNeeded(p: string): string {
  if (/\s/.test(p) && !p.startsWith('"')) return `"${p}"`;
  return p;
}

function isNotFound(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT",
  );
}

function isExists(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code: string }).code === "EEXIST",
  );
}

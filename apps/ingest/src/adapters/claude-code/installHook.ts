import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HOOK_COMMAND = "bm-pilot capture-git-sha";
export const HOOK_TYPE = "command";
export const HOOK_EVENT = "SessionStart";

export interface InstallHookOptions {
  settingsPath?: string;
  command?: string;
}

export interface InstallHookResult {
  path: string;
  changed: boolean;
  backedUpTo: string | null;
}

export function defaultSettingsPath(home: string = homedir()): string {
  return join(home, ".claude", "settings.json");
}

export async function installClaudeSessionStartHook(
  opts: InstallHookOptions = {},
): Promise<InstallHookResult> {
  const path = opts.settingsPath ?? defaultSettingsPath();
  const command = opts.command ?? HOOK_COMMAND;

  let existing: Record<string, unknown> = {};
  let hadFile = false;
  try {
    const raw = await readFile(path, "utf8");
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
    hadFile = true;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  const originalJson = JSON.stringify(existing);
  const next = mergeHook(existing, command);
  const changed = JSON.stringify(next) !== originalJson;
  if (!changed) {
    return { path, changed: false, backedUpTo: null };
  }

  let backedUpTo: string | null = null;
  if (hadFile) {
    backedUpTo = `${path}.bak`;
    try {
      // Only back up on the first change — if a .bak already exists, preserve it.
      await copyFile(path, backedUpTo, 0o1 /* COPYFILE_EXCL */);
    } catch (err) {
      if (!isEexists(err)) throw err;
    }
  }

  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "w" });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }

  return { path, changed: true, backedUpTo };
}

interface HookEntry {
  type?: string;
  command?: string;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

function mergeHook(settings: Record<string, unknown>, command: string): Record<string, unknown> {
  const out = { ...settings };
  const hooksRaw = out.hooks;
  const hooks: Record<string, unknown> =
    hooksRaw && typeof hooksRaw === "object" && !Array.isArray(hooksRaw)
      ? { ...(hooksRaw as Record<string, unknown>) }
      : {};
  const eventRaw = hooks[HOOK_EVENT];
  const groups: HookGroup[] = Array.isArray(eventRaw) ? (eventRaw as HookGroup[]) : [];

  let mutated = false;
  let installed = false;
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    const entries = Array.isArray(g.hooks) ? g.hooks : [];
    if (entries.some((e) => e?.type === HOOK_TYPE && e?.command === command)) {
      installed = true;
      break;
    }
  }

  if (!installed) {
    let targetGroup: HookGroup | null = null;
    for (const g of groups) {
      if (g && typeof g === "object" && (g.matcher === undefined || g.matcher === "")) {
        targetGroup = g;
        break;
      }
    }
    if (!targetGroup) {
      targetGroup = { matcher: "", hooks: [] };
      groups.push(targetGroup);
      mutated = true;
    }
    const entries = Array.isArray(targetGroup.hooks) ? targetGroup.hooks : [];
    entries.push({ type: HOOK_TYPE, command });
    targetGroup.hooks = entries;
    mutated = true;
  }

  if (mutated || !(HOOK_EVENT in hooks)) {
    hooks[HOOK_EVENT] = groups;
    out.hooks = hooks;
  }
  return out;
}

function isNotFound(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT",
  );
}

function isEexists(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code: string }).code === "EEXIST",
  );
}

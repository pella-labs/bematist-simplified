import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SESSION_FILE_NAME } from "./trailerHook";

export function defaultCurrentSessionPath(home: string = homedir()): string {
  return join(home, ".bm-pilot", SESSION_FILE_NAME);
}

export async function writeCurrentSession(sessionId: string, path?: string): Promise<void> {
  const target = path ?? defaultCurrentSessionPath();
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${sessionId}\n`, { mode: 0o600, flag: "w" });
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function clearCurrentSession(path?: string): Promise<void> {
  const target = path ?? defaultCurrentSessionPath();
  try {
    await unlink(target);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return;
    }
    throw err;
  }
}

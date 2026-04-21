import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const AdapterConfigSchema = z
  .object({
    enabled: z.boolean(),
  })
  .passthrough();

export const ConfigSchema = z
  .object({
    apiUrl: z.string().url(),
    ingestKey: z.string().nullable(),
    deviceId: z.string().uuid(),
    adapters: z.record(AdapterConfigSchema),
    installedAt: z.string().datetime({ offset: true }),
    // Set by `bm-pilot git enable` to remember the prior value of
    // `core.hooksPath` so `bm-pilot git disable` can restore it. `null`
    // means "no prior hooks path was set".
    gitHooksPathBackup: z.string().nullable().optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_API_URL = "http://localhost:8000";

export function defaultConfigPath(home: string = homedir()): string {
  return join(home, ".bm-pilot", "config.json");
}

export function freshConfig(apiUrl: string = DEFAULT_API_URL): Config {
  return {
    apiUrl,
    ingestKey: null,
    deviceId: randomUUID(),
    adapters: { mock: { enabled: true } },
    installedAt: new Date().toISOString(),
  };
}

export async function readConfig(path: string = defaultConfigPath()): Promise<Config | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return ConfigSchema.parse(parsed);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function writeConfig(
  config: Config,
  path: string = defaultConfigPath(),
): Promise<void> {
  ConfigSchema.parse(config);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function loadOrInit(path: string = defaultConfigPath()): Promise<Config> {
  const existing = await readConfig(path);
  if (existing) return existing;
  const c = freshConfig();
  await writeConfig(c, path);
  return c;
}

function isNotFound(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT",
  );
}

import type { Config } from "./config";

const KEY_PATTERN =
  /^bm_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Za-z0-9]{8,64}_[A-Za-z0-9]{16,}$/;

export function validateIngestKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      "ingest key format invalid: expected `bm_<orgId>_<keyId>_<secret>` from the dashboard",
    );
  }
}

export interface LoginPrompts {
  prompt(question: string): Promise<string>;
  print(msg: string): void;
}

export async function runLoginFlow(prompts: LoginPrompts, config: Config): Promise<Config> {
  prompts.print(`Sign in at ${config.apiUrl} and generate an ingest key.`);
  prompts.print("Paste the key below (format: bm_<orgId>_<keyId>_<secret>):");
  const key = (await prompts.prompt("ingest key: ")).trim();
  validateIngestKey(key);
  return { ...config, ingestKey: key };
}

export function clearIngestKey(config: Config): Config {
  return { ...config, ingestKey: null };
}

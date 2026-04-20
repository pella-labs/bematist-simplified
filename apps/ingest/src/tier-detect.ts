import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ClaudeTier = "max_200" | "pro_20" | "api_key" | null;
export type CodexTier = "plus" | "pro" | "team" | "api_key" | null;
export type CursorTier = null;

export interface DetectedTiers {
  claude: ClaudeTier;
  codex: CodexTier;
  cursor: CursorTier;
}

export interface DetectOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    const body = await readFile(path, "utf8");
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function pickString(obj: unknown, keys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function normalizeClaudePlan(raw: string | null): ClaudeTier {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes("max")) return "max_200";
  if (s.includes("pro")) return "pro_20";
  return null;
}

function normalizeCodexPlan(raw: string | null): CodexTier {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes("team") || s.includes("enterprise")) return "team";
  if (s.includes("pro")) return "pro";
  if (s.includes("plus")) return "plus";
  return null;
}

async function detectClaude(homeDir: string, env: NodeJS.ProcessEnv): Promise<ClaudeTier> {
  const credsPath = join(homeDir, ".claude", ".credentials.json");
  const creds = await readJsonIfExists(credsPath);
  if (creds && typeof creds === "object") {
    const root = creds as Record<string, unknown>;
    const subscription = root.subscription ?? root.account ?? root.plan;
    const planName =
      pickString(subscription, ["plan", "tier", "name", "type"]) ??
      pickString(root, ["plan", "tier", "subscription_type"]);
    const normalized = normalizeClaudePlan(planName);
    if (normalized) return normalized;
    if (
      root.access_token !== undefined ||
      root.oauth !== undefined ||
      (subscription && typeof subscription === "object")
    ) {
      return "pro_20";
    }
  }
  if (typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0) {
    return "api_key";
  }
  return null;
}

async function detectCodex(homeDir: string, env: NodeJS.ProcessEnv): Promise<CodexTier> {
  const authPath = join(homeDir, ".codex", "auth.json");
  const auth = await readJsonIfExists(authPath);
  if (auth && typeof auth === "object") {
    const root = auth as Record<string, unknown>;
    const tokens = root.tokens ?? root.subscription ?? root.account;
    const planName =
      pickString(tokens, ["plan", "tier", "plan_type", "subscription"]) ??
      pickString(root, ["plan", "tier", "plan_type", "subscription"]);
    const normalized = normalizeCodexPlan(planName);
    if (normalized) return normalized;
    if (
      root.OPENAI_API_KEY !== undefined ||
      (typeof root.tokens === "object" && root.tokens !== null)
    ) {
      return "plus";
    }
  }
  if (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0) {
    return "api_key";
  }
  return null;
}

export async function detectTiers(opts: DetectOptions = {}): Promise<DetectedTiers> {
  const home = opts.homeDir ?? homedir();
  const env = opts.env ?? process.env;
  const [claude, codex] = await Promise.all([detectClaude(home, env), detectCodex(home, env)]);
  return { claude, codex, cursor: null };
}

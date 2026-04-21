import { createSign } from "node:crypto";
import { repos as reposTable } from "@bematist/db/schema";
import { sql as sqlTag } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string | null;
  archived?: boolean;
}

export type ListReposFn = (input: {
  installationId: number;
  appId: string | number;
  privateKeyPem: string;
  fetchFn?: typeof fetch;
  apiBase?: string;
}) => Promise<GitHubRepo[]>;

// Mirrors apps/api/src/github/jwt.ts. Copied rather than imported to avoid
// @bematist/api (a Bun.serve entrypoint) landing in Next.js's bundle graph.
function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function mintAppJwt(appId: string | number, privateKeyPem: string, now: () => number): string {
  const nowSec = Math.floor(now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSec - 60,
    exp: nowSec + 9 * 60,
    iss: typeof appId === "number" ? appId : Number(appId),
  };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

function normalizePrivateKey(raw: string): string {
  if (raw.trimStart().startsWith("-----BEGIN")) return raw;
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  if (!decoded.includes("-----BEGIN")) {
    throw new Error("GITHUB_APP_PRIVATE_KEY: not a PEM and not base64(PEM)");
  }
  return decoded;
}

export const listInstallationReposDefault: ListReposFn = async ({
  installationId,
  appId,
  privateKeyPem,
  fetchFn,
  apiBase,
}) => {
  const doFetch = fetchFn ?? fetch;
  const base = apiBase ?? "https://api.github.com";
  const jwt = mintAppJwt(appId, normalizePrivateKey(privateKeyPem), Date.now);
  const tokenRes = await doFetch(
    `${base}/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!tokenRes.ok) {
    throw new Error(`github-app:install-token-failed:${tokenRes.status}`);
  }
  const tokenBody = (await tokenRes.json()) as { token?: string; expires_at?: string };
  if (!tokenBody.token) throw new Error("github-app:install-token-malformed");
  const token = tokenBody.token;

  const out: GitHubRepo[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const res = await doFetch(`${base}/installation/repositories?per_page=100&page=${page}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) {
      throw new Error(`github-app:list-repos-failed:${res.status}`);
    }
    const body = (await res.json()) as { repositories?: GitHubRepo[] };
    const batch = body.repositories ?? [];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
};

// Matches the shape written by apps/api/src/github/handlers/installation.ts's
// upsertRepos. Uses withOrgScope-style RLS scoping via drizzle so the web
// app can reuse the app_bematist (NOBYPASSRLS) connection.
export async function upsertReposWithOrgScope(
  orgId: string,
  installationId: number,
  repos: GitHubRepo[],
): Promise<void> {
  if (repos.length === 0) return;
  if (!/^[0-9a-fA-F-]{36}$/.test(orgId)) throw new Error(`invalid orgId: ${orgId}`);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: 2, prepare: false });
  try {
    const db = drizzle(client);
    await db.transaction(async (tx) => {
      await tx.execute(sqlTag`SELECT set_config('app.current_org_id', ${orgId}, true)`);
      for (const r of repos) {
        await tx
          .insert(reposTable)
          .values({
            orgId,
            installationId,
            githubRepoId: r.id,
            name: r.full_name ?? r.name,
            defaultBranch: r.default_branch ?? null,
          })
          .onConflictDoUpdate({
            target: reposTable.githubRepoId,
            set: {
              installationId,
              name: r.full_name ?? r.name,
              defaultBranch: sqlTag`COALESCE(EXCLUDED.default_branch, ${reposTable.defaultBranch})`,
              archivedAt: null,
            },
          });
      }
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

export interface BackfillDeps {
  listReposFn?: ListReposFn;
  upsertReposFn?: (orgId: string, installationId: number, repos: GitHubRepo[]) => Promise<void>;
  fetchFn?: typeof fetch;
  apiBase?: string;
  env?: { appId?: string | number; privateKey?: string };
}

/**
 * Best-effort repo backfill. Any failure is logged and swallowed — the admin
 * install flow must succeed even when GitHub API is flaky or creds are
 * missing, because the `installation.created` webhook will pick it up as a
 * fallback.
 */
export async function backfillReposForInstallation(
  input: { orgId: string; installationId: number },
  deps: BackfillDeps = {},
): Promise<{ ok: boolean; reason?: string; count?: number }> {
  const listFn = deps.listReposFn ?? listInstallationReposDefault;
  const upsert = deps.upsertReposFn ?? upsertReposWithOrgScope;
  const appId = deps.env?.appId ?? process.env.GITHUB_APP_ID;
  const privateKey = deps.env?.privateKey ?? process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    if (!deps.listReposFn) {
      console.warn(
        "[admin/github/callback] skipping repo backfill: GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY not set",
      );
      return { ok: false, reason: "missing-creds" };
    }
  }

  try {
    const repos = await listFn({
      installationId: input.installationId,
      appId: appId ?? "",
      privateKeyPem: privateKey ?? "",
      fetchFn: deps.fetchFn,
      apiBase: deps.apiBase,
    });
    await upsert(input.orgId, input.installationId, repos);
    return { ok: true, count: repos.length };
  } catch (err) {
    console.error("[admin/github/callback] repo backfill failed", err);
    return { ok: false, reason: "backfill-error" };
  }
}

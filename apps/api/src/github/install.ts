import { mintAppJwt, normalizePrivateKey } from "./jwt";

export type FetchFn = typeof fetch;

export interface InstallationTokenCache {
  get(installationId: string): string | null;
  set(installationId: string, token: string, expiresAtMs: number): void;
  delete(installationId: string): void;
}

interface Entry {
  token: string;
  expiresAt: number;
}

export function createInMemoryInstallationTokenCache(opts: { clock?: () => number } = {}) {
  const clock = opts.clock ?? (() => Date.now());
  const map = new Map<string, Entry>();
  const cache: InstallationTokenCache = {
    get(id) {
      const hit = map.get(id);
      if (!hit) return null;
      if (hit.expiresAt <= clock()) {
        map.delete(id);
        return null;
      }
      return hit.token;
    },
    set(id, token, expiresAtMs) {
      map.set(id, { token, expiresAt: expiresAtMs });
    },
    delete(id) {
      map.delete(id);
    },
  };
  return cache;
}

export interface GetInstallationTokenInput {
  installationId: string | number;
  appId: string | number;
  privateKeyPem: string;
  cache: InstallationTokenCache;
  fetchFn?: FetchFn;
  apiBase?: string;
  now?: () => number;
}

export async function getInstallationToken(input: GetInstallationTokenInput): Promise<string> {
  const id = String(input.installationId);
  const cached = input.cache.get(id);
  if (cached) return cached;

  const doFetch = input.fetchFn ?? fetch;
  const apiBase = input.apiBase ?? "https://api.github.com";
  const now = input.now ?? Date.now;
  const appJwt = mintAppJwt({
    appId: input.appId,
    privateKeyPem: normalizePrivateKey(input.privateKeyPem),
    now,
  });
  const res = await doFetch(
    `${apiBase}/app/installations/${encodeURIComponent(id)}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${appJwt}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`github-app:install-token-failed:${res.status}`);
  }
  const body = (await res.json()) as { token?: string; expires_at?: string };
  if (!body.token || !body.expires_at) {
    throw new Error("github-app:install-token-malformed");
  }
  const expiresAtMs = Date.parse(body.expires_at) - 60_000;
  input.cache.set(id, body.token, expiresAtMs);
  return body.token;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string | null;
  archived?: boolean;
}

export interface ListInstallationReposInput {
  installationId: string | number;
  appId: string | number;
  privateKeyPem: string;
  cache: InstallationTokenCache;
  fetchFn?: FetchFn;
  apiBase?: string;
  now?: () => number;
}

export async function listInstallationRepos(
  input: ListInstallationReposInput,
): Promise<GitHubRepo[]> {
  const doFetch = input.fetchFn ?? fetch;
  const apiBase = input.apiBase ?? "https://api.github.com";
  const token = await getInstallationToken(input);
  const out: GitHubRepo[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const res = await doFetch(`${apiBase}/installation/repositories?per_page=100&page=${page}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) {
      throw new Error(`github-app:list-repos-failed:${res.status}`);
    }
    const body = (await res.json()) as {
      total_count?: number;
      repositories?: GitHubRepo[];
    };
    const batch = body.repositories ?? [];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

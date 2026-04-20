import type { Sql } from "postgres";
import type { GitHubRepo, InstallationTokenCache } from "../install";
import { listInstallationRepos } from "../install";

export interface InstallationPayload {
  action: "created" | "deleted" | "suspend" | "unsuspend" | "new_permissions_accepted" | string;
  installation: {
    id: number;
    account?: { login?: string };
  };
  repositories?: Array<{
    id: number;
    name: string;
    full_name?: string;
    default_branch?: string | null;
  }>;
}

export interface InstallationHandlerDeps {
  sql: Sql;
  orgId: string;
  listRepos?: () => Promise<GitHubRepo[]>;
  tokenCache?: InstallationTokenCache;
  githubAppId?: string | number;
  githubAppPrivateKey?: string;
  fetchFn?: typeof fetch;
  apiBase?: string;
}

export async function handleInstallation(
  payload: InstallationPayload,
  deps: InstallationHandlerDeps,
): Promise<void> {
  const { sql, orgId } = deps;
  const installationId = payload.installation.id;
  const action = payload.action;

  if (action === "created") {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx`
        INSERT INTO github_installations (org_id, installation_id, status)
        VALUES (${orgId}, ${installationId}, 'active')
        ON CONFLICT (installation_id) DO UPDATE SET status = 'active'
      `;
    });

    const repos = await resolveRepos(payload, deps);
    await upsertRepos(sql, orgId, installationId, repos);
    return;
  }

  if (action === "deleted") {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx`
        UPDATE github_installations
        SET status = 'deleted'
        WHERE installation_id = ${installationId}
      `;
    });
    if (deps.tokenCache) deps.tokenCache.delete(String(installationId));
    return;
  }

  if (action === "suspend") {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx`
        UPDATE github_installations
        SET status = 'suspended'
        WHERE installation_id = ${installationId}
      `;
    });
    return;
  }

  if (action === "unsuspend") {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx`
        UPDATE github_installations
        SET status = 'active'
        WHERE installation_id = ${installationId}
      `;
    });
  }
}

async function resolveRepos(
  payload: InstallationPayload,
  deps: InstallationHandlerDeps,
): Promise<GitHubRepo[]> {
  if (deps.listRepos) return await deps.listRepos();
  const inline = payload.repositories ?? [];
  if (inline.length > 0) {
    return inline.map((r) => ({
      id: r.id,
      name: r.name,
      full_name: r.full_name ?? r.name,
      default_branch: r.default_branch ?? null,
    }));
  }
  // Fall through to REST when we have creds. In local tests without creds,
  // returning [] is correct — the webhook payload already covers the common
  // case (GitHub includes `repositories` on `installation.created`).
  if (deps.tokenCache && deps.githubAppId && deps.githubAppPrivateKey) {
    return listInstallationRepos({
      installationId: payload.installation.id,
      appId: deps.githubAppId,
      privateKeyPem: deps.githubAppPrivateKey,
      cache: deps.tokenCache,
      fetchFn: deps.fetchFn,
      apiBase: deps.apiBase,
    });
  }
  return [];
}

export async function upsertRepos(
  sql: Sql,
  orgId: string,
  installationId: number,
  repos: GitHubRepo[],
): Promise<void> {
  if (repos.length === 0) return;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    for (const r of repos) {
      await tx`
        INSERT INTO repos (org_id, installation_id, github_repo_id, name, default_branch)
        VALUES (${orgId}, ${installationId}, ${r.id}, ${r.full_name ?? r.name}, ${r.default_branch ?? null})
        ON CONFLICT (github_repo_id) DO UPDATE SET
          installation_id = EXCLUDED.installation_id,
          name = EXCLUDED.name,
          default_branch = COALESCE(EXCLUDED.default_branch, repos.default_branch),
          archived_at = NULL
      `;
    }
  });
}

export interface InstallationRepositoriesPayload {
  action: "added" | "removed" | string;
  installation: { id: number };
  repositories_added?: Array<{
    id: number;
    name: string;
    full_name?: string;
    default_branch?: string | null;
  }>;
  repositories_removed?: Array<{ id: number; name: string }>;
}

export async function handleInstallationRepositories(
  payload: InstallationRepositoriesPayload,
  deps: InstallationHandlerDeps,
): Promise<void> {
  const installationId = payload.installation.id;
  const added = (payload.repositories_added ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    full_name: r.full_name ?? r.name,
    default_branch: r.default_branch ?? null,
  }));
  if (added.length > 0) {
    await upsertRepos(deps.sql, deps.orgId, installationId, added);
  }
  const removed = payload.repositories_removed ?? [];
  if (removed.length > 0) {
    await deps.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${deps.orgId}, true)`;
      for (const r of removed) {
        await tx`
          UPDATE repos SET archived_at = NOW()
          WHERE org_id = ${deps.orgId} AND github_repo_id = ${r.id}
        `;
      }
    });
  }
}

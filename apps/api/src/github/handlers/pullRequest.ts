import type { Sql } from "postgres";

export interface PullRequestPayload {
  action: "opened" | "closed" | "reopened" | "synchronize" | "edited" | string;
  number: number;
  pull_request: {
    number: number;
    title: string;
    state: "open" | "closed";
    merged: boolean;
    merged_at: string | null;
    user?: { login?: string } | null;
    base?: { sha?: string } | null;
    head?: { sha?: string } | null;
  };
  repository: {
    id: number;
    name: string;
    full_name?: string;
    default_branch?: string;
  };
  installation: { id: number };
}

export interface PullRequestHandlerDeps {
  sql: Sql;
  orgId: string;
}

export async function handlePullRequest(
  payload: PullRequestPayload,
  deps: PullRequestHandlerDeps,
): Promise<void> {
  const { sql, orgId } = deps;
  const pr = payload.pull_request;
  const repo = payload.repository;
  const installationId = payload.installation.id;
  const mergedAt = pr.merged && pr.merged_at ? new Date(pr.merged_at) : null;
  const state = pr.state;

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;

    const repoRow = await tx<{ id: string }[]>`
      INSERT INTO repos (org_id, installation_id, github_repo_id, name, default_branch)
      VALUES (${orgId}, ${installationId}, ${repo.id}, ${repo.full_name ?? repo.name}, ${repo.default_branch ?? null})
      ON CONFLICT (github_repo_id) DO UPDATE SET
        installation_id = EXCLUDED.installation_id,
        name = EXCLUDED.name
      RETURNING id
    `;
    const repoId = repoRow[0]?.id;
    if (!repoId) throw new Error("repos upsert returned no row");

    await tx`
      INSERT INTO github_prs (
        org_id, repo_id, number, title, author_github_login,
        state, merged_at, base_sha, head_sha
      ) VALUES (
        ${orgId}, ${repoId}, ${pr.number}, ${pr.title}, ${pr.user?.login ?? null},
        ${state}, ${mergedAt}, ${pr.base?.sha ?? null}, ${pr.head?.sha ?? null}
      )
      ON CONFLICT (repo_id, number) DO UPDATE SET
        title = EXCLUDED.title,
        author_github_login = COALESCE(EXCLUDED.author_github_login, github_prs.author_github_login),
        state = EXCLUDED.state,
        merged_at = COALESCE(EXCLUDED.merged_at, github_prs.merged_at),
        base_sha = EXCLUDED.base_sha,
        head_sha = EXCLUDED.head_sha
    `;
  });
}

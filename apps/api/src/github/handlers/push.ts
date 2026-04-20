import type { Sql } from "postgres";

export interface PushCommit {
  id: string;
  message: string;
  timestamp: string;
  author: { email?: string; username?: string; name?: string };
  committer?: { email?: string; username?: string; name?: string };
}

export interface PushPayload {
  ref: string;
  after: string;
  commits: PushCommit[];
  head_commit?: PushCommit | null;
  pusher?: { name?: string; email?: string };
  repository: {
    id: number;
    name: string;
    full_name?: string;
    default_branch?: string;
  };
  installation: { id: number };
}

export interface PushHandlerDeps {
  sql: Sql;
  orgId: string;
}

function branchFromRef(ref: string): string | null {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  return null;
}

export async function handlePush(payload: PushPayload, deps: PushHandlerDeps): Promise<void> {
  const { sql, orgId } = deps;
  const repo = payload.repository;
  const installationId = payload.installation.id;
  const branch = branchFromRef(payload.ref);
  const commits = payload.commits ?? [];
  if (commits.length === 0) return;

  const pushedAt = new Date();

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

    for (const c of commits) {
      // Try to link to an open PR whose head_sha equals this commit.
      // Missing PR → prId stays null and can be backfilled later.
      const prRow = await tx<{ id: string }[]>`
        SELECT id FROM github_prs
        WHERE org_id = ${orgId} AND repo_id = ${repoId} AND head_sha = ${c.id}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const prId = prRow[0]?.id ?? null;

      const authorEmail = c.author?.email ?? null;
      const authorLogin = c.author?.username ?? null;
      const committedAt = c.timestamp ? new Date(c.timestamp) : null;

      await tx`
        INSERT INTO github_commits (
          org_id, repo_id, sha, author_email, author_github_login,
          message, branch, committed_at, pushed_at, pr_id
        ) VALUES (
          ${orgId}, ${repoId}, ${c.id}, ${authorEmail}, ${authorLogin},
          ${c.message}, ${branch}, ${committedAt}, ${pushedAt}, ${prId}
        )
        ON CONFLICT (repo_id, sha) DO UPDATE SET
          author_email = COALESCE(github_commits.author_email, EXCLUDED.author_email),
          author_github_login = COALESCE(github_commits.author_github_login, EXCLUDED.author_github_login),
          message = COALESCE(github_commits.message, EXCLUDED.message),
          branch = COALESCE(github_commits.branch, EXCLUDED.branch),
          pushed_at = EXCLUDED.pushed_at,
          pr_id = COALESCE(github_commits.pr_id, EXCLUDED.pr_id)
      `;
    }
  });
}

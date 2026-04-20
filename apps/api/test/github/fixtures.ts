import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";

export interface SeededInstallation {
  orgId: string;
  installationId: number;
}

let INSTALLATION_COUNTER = 100_000_000;

export async function seedInstallation(
  sql: Sql,
  opts: { installationId?: number; status?: "active" | "deleted" | "suspended" } = {},
): Promise<SeededInstallation> {
  const orgId = randomUUID();
  const installationId = opts.installationId ?? ++INSTALLATION_COUNTER;
  const status = opts.status ?? "active";
  const slug = `org-${installationId}`;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    await tx`INSERT INTO orgs (id, slug, name) VALUES (${orgId}, ${slug}, ${slug})`;
    await tx`
      INSERT INTO github_installations (org_id, installation_id, status)
      VALUES (${orgId}, ${installationId}, ${status})
    `;
  });
  return { orgId, installationId };
}

export function pushEvent(opts: {
  installationId: number;
  repoId?: number;
  commits?: Array<{
    id: string;
    message: string;
    timestamp: string;
    author: { email: string; name: string; username?: string };
  }>;
  ref?: string;
}): unknown {
  const repoId = opts.repoId ?? 10001;
  return {
    ref: opts.ref ?? "refs/heads/main",
    after: opts.commits?.[opts.commits.length - 1]?.id ?? "a".repeat(40),
    commits: opts.commits ?? [
      {
        id: "0000000000000000000000000000000000000001",
        message: "initial",
        timestamp: "2026-04-01T00:00:00Z",
        author: { email: "alice@example.com", name: "Alice", username: "alice" },
      },
    ],
    head_commit: null,
    pusher: { name: "alice", email: "alice@example.com" },
    repository: {
      id: repoId,
      name: "demo",
      full_name: "org/demo",
      default_branch: "main",
    },
    installation: { id: opts.installationId },
  };
}

export function pullRequestEvent(opts: {
  installationId: number;
  repoId?: number;
  action: "opened" | "closed" | "reopened" | "synchronize";
  number: number;
  merged?: boolean;
  mergedAt?: string | null;
  state?: "open" | "closed";
  headSha?: string;
  baseSha?: string;
}): unknown {
  const repoId = opts.repoId ?? 10001;
  const merged = opts.merged ?? false;
  const state = opts.state ?? (opts.action === "closed" ? "closed" : "open");
  return {
    action: opts.action,
    number: opts.number,
    pull_request: {
      number: opts.number,
      title: `PR ${opts.number}`,
      state,
      merged,
      merged_at: merged ? (opts.mergedAt ?? "2026-04-02T01:00:00Z") : null,
      user: { login: "alice" },
      base: { sha: opts.baseSha ?? "b".repeat(40) },
      head: { sha: opts.headSha ?? "a".repeat(40) },
    },
    repository: {
      id: repoId,
      name: "demo",
      full_name: "org/demo",
      default_branch: "main",
    },
    installation: { id: opts.installationId },
  };
}

export function installationEvent(opts: {
  installationId: number;
  action: "created" | "deleted" | "suspend" | "unsuspend";
  repositories?: Array<{ id: number; name: string; full_name?: string }>;
}): unknown {
  return {
    action: opts.action,
    installation: {
      id: opts.installationId,
      account: { login: "fixture-org" },
    },
    repositories: opts.repositories ?? [],
  };
}

export function installationRepositoriesEvent(opts: {
  installationId: number;
  action: "added" | "removed";
  added?: Array<{ id: number; name: string; full_name?: string; default_branch?: string | null }>;
  removed?: Array<{ id: number; name: string }>;
}): unknown {
  return {
    action: opts.action,
    installation: { id: opts.installationId },
    repositories_added: opts.added ?? [],
    repositories_removed: opts.removed ?? [],
  };
}

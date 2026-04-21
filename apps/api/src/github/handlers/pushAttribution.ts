import { runScanAttribution } from "@bematist/worker/src/jobs/attribute-scan";
import {
  runTrailerAttribution,
  type TrailerCommit,
} from "@bematist/worker/src/jobs/attribute-trailer";
import type { Sql } from "postgres";
import type { PushPayload } from "./push";

export interface PushAttributionDeps {
  sql: Sql;
  orgId: string;
}

export interface PushAttributionResult {
  trailerLinks: number;
  scanLinks: number;
}

/**
 * Synchronous-with-webhook attribution: every push event triggers trailer
 * parsing + cwd+author+time fallback. Both write into
 * `session_commit_links` with distinct `signal` values, so multiple rows
 * may exist for a single (session, commit) pair.
 */
export async function runPushAttribution(
  payload: PushPayload,
  deps: PushAttributionDeps,
): Promise<PushAttributionResult> {
  const commits = payload.commits ?? [];
  if (commits.length === 0) return { trailerLinks: 0, scanLinks: 0 };

  const trailerCommits: TrailerCommit[] = commits.map((c) => ({
    sha: c.id,
    message: c.message,
  }));
  const trailer = await runTrailerAttribution({
    sql: deps.sql,
    orgId: deps.orgId,
    commits: trailerCommits,
  });

  const scanCommits = commits.map((c) => ({
    sha: c.id,
    message: c.message,
    authorEmail: c.author?.email ?? null,
    committedAt: c.timestamp ?? null,
  }));
  const scan = await runScanAttribution({
    sql: deps.sql,
    orgId: deps.orgId,
    commits: scanCommits,
  });

  return { trailerLinks: trailer.linked, scanLinks: scan.linked };
}

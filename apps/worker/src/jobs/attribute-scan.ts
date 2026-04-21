import type { Sql } from "postgres";
import { extractSessionIds } from "./attribute-trailer";

export const SCAN_SIGNAL = "webhook_scan";
export const SCAN_CONFIDENCE = 0.4;
export const DEFAULT_SCAN_WINDOW_MS = 10 * 60 * 1000;

export interface ScanCommit {
  sha: string;
  message: string;
  authorEmail: string | null;
  committedAt: Date | string | null;
}

export interface RunScanAttributionOptions {
  sql: Sql;
  orgId: string;
  commits: ScanCommit[];
  windowMs?: number;
}

export interface RunScanAttributionResult {
  scanned: number;
  considered: number;
  linked: number;
  writes: Array<{ sessionId: string; commitSha: string }>;
}

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Fallback attribution on `push`: for every commit without a parseable
 * `Bematist-Session` trailer, try to link to a session owned by the same
 * developer (matched by email) whose time window overlaps `committed_at`.
 * Signal `webhook_scan`, confidence 0.4.
 */
export async function runScanAttribution(
  opts: RunScanAttributionOptions,
): Promise<RunScanAttributionResult> {
  const { sql, orgId, commits } = opts;
  const windowMs = opts.windowMs ?? DEFAULT_SCAN_WINDOW_MS;
  if (commits.length === 0) {
    return { scanned: 0, considered: 0, linked: 0, writes: [] };
  }
  let considered = 0;
  let linked = 0;
  const writes: Array<{ sessionId: string; commitSha: string }> = [];

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    for (const commit of commits) {
      if (extractSessionIds(commit.message).length > 0) continue;
      const email = commit.authorEmail;
      const committedAt = toDate(commit.committedAt);
      if (!email || !committedAt) continue;
      considered++;
      const lower = new Date(committedAt.getTime() - windowMs);
      const upper = new Date(committedAt.getTime() + windowMs);
      const sessions = await tx<{ id: string }[]>`
        SELECT s.id FROM sessions s
        JOIN developers d ON d.id = s.developer_id AND d.org_id = s.org_id
        WHERE s.org_id = ${orgId}
          AND d.email = ${email}
          AND s.started_at <= ${upper}
          AND (s.ended_at IS NULL OR s.ended_at >= ${lower})
      `;
      for (const s of sessions) {
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO session_commit_links (org_id, session_id, commit_sha, signal, confidence)
          VALUES (${orgId}, ${s.id}, ${commit.sha}, ${SCAN_SIGNAL}, ${SCAN_CONFIDENCE})
          ON CONFLICT (session_id, commit_sha, signal) DO NOTHING
          RETURNING id
        `;
        if (inserted.length > 0) {
          linked++;
          writes.push({ sessionId: s.id, commitSha: commit.sha });
        }
      }
    }
  });

  return { scanned: commits.length, considered, linked, writes };
}

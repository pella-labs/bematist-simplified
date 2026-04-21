import type { Sql } from "postgres";

export const CWD_TIME_SIGNAL = "cwd_time";
export const CWD_TIME_CONFIDENCE = 0.6;
export const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_LOOKBACK_MS = 60 * 60 * 1000;

export interface RunCwdTimeAttributionOptions {
  sql: Sql;
  /** Override the "new session" lookback window. Defaults to 1h. */
  lookbackMs?: number;
  /** Extend the commit time window on either side of the session. Defaults to 10min. */
  windowMs?: number;
  /** Clock seam for tests. */
  now?: () => Date;
}

export interface RunCwdTimeAttributionResult {
  sessionsScanned: number;
  orgs: number;
  linked: number;
}

interface SessionRow {
  id: string;
  org_id: string;
  cwd: string | null;
  started_at: string;
  ended_at: string | null;
}

interface RepoRow {
  id: string;
  name: string;
}

function extractRepoBaseName(name: string): string {
  // `repos.name` is typically `org/repo` (the full_name). Take the short repo
  // name so we can match it against a developer's cwd path segment.
  const slash = name.lastIndexOf("/");
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  return base.trim();
}

/**
 * Returns true if `cwd` contains the repo short name as a path segment.
 * Case-insensitive, path-separator tolerant (works for macOS/Linux/Windows).
 */
export function cwdMatchesRepo(cwd: string, repoName: string): boolean {
  const base = extractRepoBaseName(repoName).toLowerCase();
  if (base.length === 0) return false;
  const norm = cwd.replace(/\\/g, "/").toLowerCase();
  const parts = norm.split("/").filter((p) => p.length > 0);
  return parts.some((p) => p === base);
}

/**
 * For every session that started within the last `lookbackMs`, try to find a
 * repo whose base name is a path segment of the session's `cwd`, then for
 * every commit on that repo inside the session's time window (±10 min),
 * insert a `session_commit_links` row with signal `cwd_time`. Idempotent.
 */
export async function runCwdTimeAttribution(
  opts: RunCwdTimeAttributionOptions,
): Promise<RunCwdTimeAttributionResult> {
  const { sql } = opts;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const lookbackMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const now = (opts.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - lookbackMs);

  const sessions = await sql<SessionRow[]>`
    SELECT id, org_id, cwd, started_at::text AS started_at, ended_at::text AS ended_at
    FROM sessions
    WHERE cwd IS NOT NULL AND started_at >= ${cutoff}
  `;
  if (sessions.length === 0) {
    return { sessionsScanned: 0, orgs: 0, linked: 0 };
  }

  const byOrg = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    let bucket = byOrg.get(s.org_id);
    if (!bucket) {
      bucket = [];
      byOrg.set(s.org_id, bucket);
    }
    bucket.push(s);
  }

  let linked = 0;
  for (const [orgId, orgSessions] of byOrg) {
    linked += await attributeForOrg(sql, orgId, orgSessions, windowMs);
  }

  return { sessionsScanned: sessions.length, orgs: byOrg.size, linked };
}

async function attributeForOrg(
  sql: Sql,
  orgId: string,
  sessions: SessionRow[],
  windowMs: number,
): Promise<number> {
  let linked = 0;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    const repos = await tx<RepoRow[]>`
      SELECT id, name FROM repos WHERE org_id = ${orgId}
    `;
    if (repos.length === 0) return;

    for (const session of sessions) {
      const cwd = session.cwd;
      if (!cwd) continue;
      const matchedRepos = repos.filter((r) => cwdMatchesRepo(cwd, r.name));
      if (matchedRepos.length === 0) continue;

      const startedAt = new Date(session.started_at);
      const endedAt = session.ended_at ? new Date(session.ended_at) : new Date();
      const lower = new Date(startedAt.getTime() - windowMs);
      const upper = new Date(endedAt.getTime() + windowMs);

      for (const repo of matchedRepos) {
        const commits = await tx<{ sha: string }[]>`
          SELECT sha FROM github_commits
          WHERE repo_id = ${repo.id}
            AND org_id = ${orgId}
            AND committed_at IS NOT NULL
            AND committed_at >= ${lower}
            AND committed_at <= ${upper}
        `;
        for (const c of commits) {
          const inserted = await tx<{ id: string }[]>`
            INSERT INTO session_commit_links (org_id, session_id, commit_sha, signal, confidence)
            VALUES (${orgId}, ${session.id}, ${c.sha}, ${CWD_TIME_SIGNAL}, ${CWD_TIME_CONFIDENCE})
            ON CONFLICT (session_id, commit_sha, signal) DO NOTHING
            RETURNING id
          `;
          if (inserted.length > 0) linked++;
        }
      }
    }
  });
  return linked;
}

export interface CwdTimeLoopHandle {
  stop: () => Promise<void>;
}

export function startCwdTimeLoop(
  options: RunCwdTimeAttributionOptions & { intervalMs: number },
): CwdTimeLoopHandle {
  const { intervalMs } = options;
  let stopped = false;
  let inFlight: Promise<RunCwdTimeAttributionResult> | null = null;

  const tick = async () => {
    if (stopped) return;
    if (inFlight) return;
    inFlight = runCwdTimeAttribution(options).catch((err) => {
      console.error("[worker/cwd-time] tick failed:", err);
      return { sessionsScanned: 0, orgs: 0, linked: 0 };
    });
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);

  return {
    async stop() {
      stopped = true;
      clearInterval(handle);
      if (inFlight) await inFlight;
    },
  };
}

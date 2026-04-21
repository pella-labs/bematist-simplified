import type { Sql } from "postgres";

export const TRAILER_KEY = "Bematist-Session";
export const TRAILER_SIGNAL = "trailer";
export const TRAILER_CONFIDENCE = 1.0;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TrailerCommit {
  sha: string;
  message: string;
}

/**
 * Parse all `Bematist-Session: <uuid>` trailer values from a commit message.
 *
 * Trailers live in the final contiguous block of lines that are each
 * `<Token>: <value>` — the same shape git interpret-trailers recognises. We
 * implement a minimal subset: find the last block and match the key.
 * Returns unique, validated UUIDs in order of appearance.
 */
export function extractSessionIds(message: string): string[] {
  if (!message) return [];
  const normalised = message.replace(/\r\n/g, "\n");
  // Trim trailing blank lines so we can find the trailing trailer block.
  const lines = normalised.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();

  // Walk backwards collecting contiguous trailer-looking lines.
  const trailers: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (line.trim() === "") break;
    if (!isTrailerLine(line)) break;
    trailers.unshift(line);
  }
  if (trailers.length === 0) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of trailers) {
    const match = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/.exec(t);
    if (!match) continue;
    const key = match[1] ?? "";
    if (key.toLowerCase() !== TRAILER_KEY.toLowerCase()) continue;
    const value = (match[2] ?? "").trim();
    if (!UUID_RE.test(value)) continue;
    const normal = value.toLowerCase();
    if (seen.has(normal)) continue;
    seen.add(normal);
    out.push(normal);
  }
  return out;
}

function isTrailerLine(line: string): boolean {
  return (
    /^[A-Za-z][A-Za-z0-9-]*\s*:\s+\S/.test(line) || /^[A-Za-z][A-Za-z0-9-]*\s*:\s*$/.test(line)
  );
}

export interface RunTrailerAttributionOptions {
  sql: Sql;
  orgId: string;
  commits: TrailerCommit[];
}

export interface AttributionWrite {
  sessionId: string;
  commitSha: string;
  signal: string;
}

export interface RunTrailerAttributionResult {
  scanned: number;
  matched: number;
  linked: number;
  writes: AttributionWrite[];
}

/**
 * For each commit, parse `Bematist-Session` trailers and create
 * `session_commit_links` rows when the referenced session exists in the
 * same tenant. Idempotent — unique index on (session_id, commit_sha, signal)
 * absorbs duplicates.
 */
export async function runTrailerAttribution(
  opts: RunTrailerAttributionOptions,
): Promise<RunTrailerAttributionResult> {
  const { sql, orgId, commits } = opts;
  if (commits.length === 0) {
    return { scanned: 0, matched: 0, linked: 0, writes: [] };
  }
  let matched = 0;
  let linked = 0;
  const writes: AttributionWrite[] = [];

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    for (const commit of commits) {
      const ids = extractSessionIds(commit.message);
      if (ids.length === 0) continue;
      matched++;
      for (const sessionId of ids) {
        const rows = await tx<{ id: string }[]>`
          SELECT id FROM sessions WHERE id = ${sessionId} AND org_id = ${orgId} LIMIT 1
        `;
        if (rows.length === 0) continue;
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO session_commit_links (org_id, session_id, commit_sha, signal, confidence)
          VALUES (${orgId}, ${sessionId}, ${commit.sha}, ${TRAILER_SIGNAL}, ${TRAILER_CONFIDENCE})
          ON CONFLICT (session_id, commit_sha, signal) DO NOTHING
          RETURNING id
        `;
        if (inserted.length > 0) {
          linked++;
          writes.push({ sessionId, commitSha: commit.sha, signal: TRAILER_SIGNAL });
        }
      }
    }
  });

  return { scanned: commits.length, matched, linked, writes };
}

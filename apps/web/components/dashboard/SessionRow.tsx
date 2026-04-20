import Link from "next/link";
import { formatRelative, formatTokens, formatUsd, signalLabel, truncateMiddle } from "./format";
import type { SessionListItem } from "./queries";

export interface SessionRowProps {
  session: SessionListItem;
  showDeveloper?: boolean;
}

function sourceLabel(source: SessionListItem["source"]): string {
  if (source === "claude-code") return "Claude Code";
  if (source === "codex") return "Codex CLI";
  return "Cursor";
}

export function SessionRow({ session, showDeveloper = true }: SessionRowProps) {
  return (
    <tr>
      <td>
        <Link href={`/sessions/${session.id}`} className="dash-table-link">
          <span className={`dash-source-dot ${session.source}`} aria-hidden />
          {sourceLabel(session.source)}
        </Link>
      </td>
      {showDeveloper ? (
        <td>
          <Link href={`/developers/${session.developerId}`} className="dash-table-link dash-mono">
            {session.developerName ?? session.developerEmail}
          </Link>
        </td>
      ) : null}
      <td className="dash-mono" style={{ color: "var(--mk-ink-muted)", fontSize: 12 }}>
        {session.cwd ? truncateMiddle(session.cwd, 32) : "—"}
      </td>
      <td className="num">{formatUsd(session.costUsd)}</td>
      <td className="num">{formatTokens(session.tokensInput + session.tokensOutput)}</td>
      <td className="num" style={{ color: "var(--mk-ink-muted)" }}>
        {formatRelative(session.startedAt)}
      </td>
      <td>
        {session.signals.length === 0 ? (
          <span className="dash-chip is-muted">—</span>
        ) : (
          <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
            {session.signals.map((s) => (
              <span key={s} className="dash-chip is-accent">
                {signalLabel(s)}
              </span>
            ))}
          </span>
        )}
      </td>
    </tr>
  );
}

export function SessionTableHeader({ showDeveloper = true }: { showDeveloper?: boolean }) {
  return (
    <thead>
      <tr>
        <th>Source</th>
        {showDeveloper ? <th>Developer</th> : null}
        <th>Working dir</th>
        <th className="num">Cost</th>
        <th className="num">Tokens</th>
        <th className="num">Started</th>
        <th>Outcome</th>
      </tr>
    </thead>
  );
}

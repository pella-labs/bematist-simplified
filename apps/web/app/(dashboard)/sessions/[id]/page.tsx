import { brand } from "@bematist/ui/brand";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  formatDurationMs,
  formatInt,
  formatTokens,
  formatUsd,
  shortSha,
  signalLabel,
} from "@/components/dashboard/format";
import { findDeveloperForUser, getSessionDetail } from "@/components/dashboard/queries";
import { Transcript } from "@/components/dashboard/Transcript";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = {
  title: `Session — ${brand.name}`,
};

interface PageProps {
  params: Promise<{ id: string }>;
}

function sourceLabel(source: "claude-code" | "codex" | "cursor"): string {
  if (source === "claude-code") return "Claude Code";
  if (source === "codex") return "Codex CLI";
  return "Cursor";
}

function durationMs(startedAt: Date, endedAt: Date | null): number | null {
  if (!endedAt) return null;
  return endedAt.getTime() - startedAt.getTime();
}

export default async function SessionDetailPage({ params }: PageProps) {
  const session = await requireSession();
  const { id } = await params;
  const detail = await getSessionDetail(session.org.id, id);
  if (!detail) notFound();

  if (session.role !== "admin") {
    const linkedDev = await findDeveloperForUser(
      session.org.id,
      session.user.id,
      session.user.email,
    );
    if (!linkedDev || linkedDev.id !== detail.developerId) {
      redirect("/me?forbidden=session");
    }
  }

  return (
    <>
      <header className="dash-page-head">
        <span className="mk-sys">Session · {sourceLabel(detail.source)}</span>
        <h1 className="dash-page-title">{detail.developerName ?? detail.developerEmail}</h1>
        <p className="dash-page-subtitle dash-mono">{detail.sourceSessionId}</p>
        <div className="dash-page-actions">
          <Link href={`/developers/${detail.developerId}`} className="dash-btn">
            Developer
          </Link>
          <Link href={`/sessions?developer=${detail.developerId}`} className="dash-btn">
            More from this developer
          </Link>
        </div>
      </header>

      <section className="dash-tiles">
        <div className="dash-tile">
          <span className="dash-tile-label">Cost</span>
          <span className="dash-tile-value">{formatUsd(detail.costUsd)}</span>
          <span className="dash-tile-sub">Across {formatInt(detail.eventCount)} events</span>
        </div>
        <div className="dash-tile">
          <span className="dash-tile-label">Tokens</span>
          <span className="dash-tile-value">
            {formatTokens(detail.tokensInput + detail.tokensOutput)}
          </span>
          <span className="dash-tile-sub">
            {formatTokens(detail.tokensInput)} in · {formatTokens(detail.tokensOutput)} out
          </span>
        </div>
        <div className="dash-tile">
          <span className="dash-tile-label">Duration</span>
          <span className="dash-tile-value">
            {formatDurationMs(durationMs(detail.startedAt, detail.endedAt))}
          </span>
          <span className="dash-tile-sub">
            {detail.startedAt.toISOString().slice(0, 16).replace("T", " ")}
            {detail.endedAt ? ` → ${detail.endedAt.toISOString().slice(11, 16)}` : " · in progress"}
          </span>
        </div>
        <div className="dash-tile">
          <span className="dash-tile-label">Outcome signals</span>
          <span className="dash-tile-value" style={{ fontSize: 20 }}>
            {detail.signals.length > 0 ? (
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {detail.signals.map((s) => (
                  <span key={s} className="dash-chip is-accent">
                    {signalLabel(s)}
                  </span>
                ))}
              </span>
            ) : (
              <span className="dash-chip is-muted">No commits linked yet</span>
            )}
          </span>
          <span className="dash-tile-sub">{detail.commitCount} commit(s)</span>
        </div>
      </section>

      <section aria-label="Session context">
        <div className="dash-card">
          <div className="dash-card-head">
            <h2 className="dash-card-title">Context</h2>
          </div>
          <div style={{ padding: "18px 22px" }}>
            <dl className="dash-kvs">
              <dt>Working dir</dt>
              <dd className="dash-mono">{detail.cwd ?? "—"}</dd>
              <dt>Git branch</dt>
              <dd className="dash-mono">{detail.gitBranch ?? "—"}</dd>
              <dt>Git SHA at start</dt>
              <dd className="dash-mono">
                {detail.gitShaAtStart ? shortSha(detail.gitShaAtStart) : "—"}
              </dd>
              <dt>Model hint</dt>
              <dd className="dash-mono">{detail.modelHint ?? "—"}</dd>
              <dt>Client version</dt>
              <dd className="dash-mono">{detail.clientVersion ?? "—"}</dd>
            </dl>
          </div>
        </div>
      </section>

      <section aria-label="Linked commits">
        <div className="dash-card">
          <div className="dash-card-head">
            <h2 className="dash-card-title">Linked commits</h2>
            <span className="dash-card-sub">{detail.commits.length}</span>
          </div>
          {detail.commits.length === 0 ? (
            <div style={{ padding: 20 }}>
              <div className="dash-empty">
                <h3 className="dash-empty-title">No commits linked yet</h3>
                <p className="dash-empty-body">
                  Commits will appear here once the attribution worker matches them via cwd+time,
                  commit trailer, or webhook scan.
                </p>
              </div>
            </div>
          ) : (
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Repo</th>
                  <th>SHA</th>
                  <th>Message</th>
                  <th>Signals</th>
                  <th>PR</th>
                </tr>
              </thead>
              <tbody>
                {detail.commits.map((c) => (
                  <tr key={c.sha}>
                    <td className="dash-mono">{c.repoName ?? "—"}</td>
                    <td className="dash-mono">{shortSha(c.sha)}</td>
                    <td>{c.message ? c.message.split("\n")[0]?.slice(0, 80) : "—"}</td>
                    <td>
                      <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                        {c.signals.map((s) => (
                          <span key={s} className="dash-chip is-accent">
                            {signalLabel(s)}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td>
                      {c.prNumber ? (
                        <span
                          className={`dash-chip ${c.prMergedAt ? "is-accent" : ""}`}
                          title={c.prTitle ?? undefined}
                        >
                          #{c.prNumber} {c.prMergedAt ? "merged" : ""}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section aria-label="Transcript">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <h2 className="dash-card-title">Transcript</h2>
          <span className="dash-card-sub">{detail.transcript.length} events</span>
        </div>
        <Transcript items={detail.transcript} />
      </section>
    </>
  );
}

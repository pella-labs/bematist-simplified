import { computeMonthlyDelta } from "@bematist/embed";
import { brand } from "@bematist/ui/brand";
import type { Metadata } from "next";
import Link from "next/link";
import { CostDeltaTile } from "@/components/dashboard/CostDeltaTile";
import { NoSessionsEmpty } from "@/components/dashboard/EmptyState";
import { formatInt, formatTokens, formatUsd, monthKey } from "@/components/dashboard/format";
import { orgScopedDb } from "@/components/dashboard/orgDb";
import { findDeveloperForUser, listSessions } from "@/components/dashboard/queries";
import { SessionRow, SessionTableHeader } from "@/components/dashboard/SessionRow";
import { StatTile } from "@/components/dashboard/StatTile";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = {
  title: `My dashboard — ${brand.name}`,
  description: "Your personal AI-coding telemetry summary.",
};

export default async function MeDashboardPage() {
  const session = await requireSession();
  const linkedDev = await findDeveloperForUser(session.org.id, session.user.id, session.user.email);

  if (!linkedDev) {
    return (
      <>
        <header className="dash-page-head">
          <span className="mk-sys">My dashboard</span>
          <h1 className="dash-page-title">No telemetry linked yet</h1>
          <p className="dash-page-subtitle">
            We could not find a developer record tied to your account. Ask your admin to link this
            email <code className="dash-mono">{session.user.email}</code> to a developer in{" "}
            {session.org.name}, or install the binary and run{" "}
            <code className="dash-mono">bm-pilot login</code>.
          </p>
        </header>
        <Link href="/install" className="dash-btn is-primary" style={{ alignSelf: "flex-start" }}>
          Installation guide
        </Link>
      </>
    );
  }

  const now = new Date();
  const db = orgScopedDb(session.org.id);
  const [delta, sessions] = await Promise.all([
    computeMonthlyDelta(db, linkedDev.id, now),
    listSessions(session.org.id, { developerId: linkedDev.id, limit: 20 }),
  ]);

  const totalTokens = sessions.reduce((acc, s) => acc + s.tokensInput + s.tokensOutput, 0);
  const totalEvents = sessions.reduce((acc, s) => acc + s.eventCount, 0);
  const mergedCount = sessions.reduce((acc, s) => acc + (s.commitCount > 0 ? 1 : 0), 0);

  return (
    <>
      <header className="dash-page-head">
        <span className="mk-sys">My dashboard</span>
        <h1 className="dash-page-title">{linkedDev.name ?? linkedDev.email}</h1>
        <p className="dash-page-subtitle">
          Your personal view of AI-coding telemetry. Only you and admins see this data for your
          account in {session.org.name}.
        </p>
      </header>

      <section className="dash-tiles" style={{ gridTemplateColumns: "1fr" }}>
        <CostDeltaTile
          actualUsd={delta.actualUsd}
          subscriptionUsd={delta.subscriptionUsd}
          deltaUsd={delta.deltaUsd}
          month={monthKey(now)}
          subjectLabel={linkedDev.name ?? linkedDev.email}
        />
      </section>

      <section className="dash-tiles">
        <StatTile
          label="Sessions"
          value={formatInt(sessions.length)}
          caption={`${formatInt(totalEvents)} events recorded`}
          index={0}
        />
        <StatTile
          label="Tokens"
          value={formatTokens(totalTokens)}
          caption="Total across your recent sessions"
          index={1}
        />
        <StatTile
          label="Sessions with commits"
          value={formatInt(mergedCount)}
          caption="Linked via cwd+time, trailer, or webhook scan"
          index={2}
        />
        <StatTile
          label="Subscription cost"
          value={formatUsd(delta.subscriptionUsd)}
          caption={`${
            [
              linkedDev.subscriptionClaude && `Claude: ${linkedDev.subscriptionClaude}`,
              linkedDev.subscriptionCodex && `Codex: ${linkedDev.subscriptionCodex}`,
              linkedDev.subscriptionCursor && `Cursor: ${linkedDev.subscriptionCursor}`,
            ]
              .filter(Boolean)
              .join(" · ") || "No subscriptions configured"
          }`}
          index={3}
        />
      </section>

      <section>
        <div className="dash-card">
          <div className="dash-card-head">
            <h2 className="dash-card-title">My recent sessions</h2>
            <span className="dash-card-sub">Last {sessions.length}</span>
          </div>
          {sessions.length === 0 ? (
            <div style={{ padding: 24 }}>
              <NoSessionsEmpty />
            </div>
          ) : (
            <table className="dash-table">
              <SessionTableHeader showDeveloper={false} />
              <tbody>
                {sessions.map((s) => (
                  <SessionRow key={s.id} session={s} showDeveloper={false} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}

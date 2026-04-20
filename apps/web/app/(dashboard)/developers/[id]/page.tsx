import { computeMonthlyDelta } from "@bematist/embed";
import { brand } from "@bematist/ui/brand";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { CostDeltaTile } from "@/components/dashboard/CostDeltaTile";
import { NoSessionsEmpty } from "@/components/dashboard/EmptyState";
import { formatInt, formatTokens, formatUsd, monthKey } from "@/components/dashboard/format";
import { orgScopedDb } from "@/components/dashboard/orgDb";
import { findDeveloperForUser, getDeveloper, listSessions } from "@/components/dashboard/queries";
import { SessionRow, SessionTableHeader } from "@/components/dashboard/SessionRow";
import { StatTile } from "@/components/dashboard/StatTile";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = {
  title: `Developer — ${brand.name}`,
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function DeveloperDetailPage({ params }: PageProps) {
  const session = await requireSession();
  const { id } = await params;
  const dev = await getDeveloper(session.org.id, id);
  if (!dev) notFound();

  if (session.role !== "admin") {
    const linkedDev = await findDeveloperForUser(
      session.org.id,
      session.user.id,
      session.user.email,
    );
    if (!linkedDev || linkedDev.id !== dev.id) {
      redirect("/me?forbidden=developer");
    }
  }

  const now = new Date();
  const db = orgScopedDb(session.org.id);
  const [delta, sessions] = await Promise.all([
    computeMonthlyDelta(db, dev.id, now),
    listSessions(session.org.id, { developerId: dev.id, limit: 50 }),
  ]);

  const totalTokens = sessions.reduce((a, s) => a + s.tokensInput + s.tokensOutput, 0);
  const totalEvents = sessions.reduce((a, s) => a + s.eventCount, 0);
  const withCommits = sessions.filter((s) => s.commitCount > 0).length;

  return (
    <>
      <header className="dash-page-head">
        <span className="mk-sys">Developer</span>
        <h1 className="dash-page-title">{dev.name ?? dev.email}</h1>
        <p className="dash-page-subtitle dash-mono">{dev.email}</p>
      </header>

      <section className="dash-tiles" style={{ gridTemplateColumns: "1fr" }}>
        <CostDeltaTile
          actualUsd={delta.actualUsd}
          subscriptionUsd={delta.subscriptionUsd}
          deltaUsd={delta.deltaUsd}
          month={monthKey(now)}
          subjectLabel={dev.name ?? dev.email}
        />
      </section>

      <section className="dash-tiles">
        <StatTile label="Sessions" value={formatInt(sessions.length)} index={0} />
        <StatTile label="Events" value={formatInt(totalEvents)} index={1} />
        <StatTile
          label="Tokens"
          value={formatTokens(totalTokens)}
          caption={`${formatTokens(sessions.reduce((a, s) => a + s.tokensInput, 0))} in · ${formatTokens(sessions.reduce((a, s) => a + s.tokensOutput, 0))} out`}
          index={2}
        />
        <StatTile
          label="Linked to commits"
          value={formatInt(withCommits)}
          caption={`${formatUsd(sessions.reduce((a, s) => a + s.costUsd, 0))} total cost`}
          index={3}
        />
      </section>

      <section>
        <div className="dash-card">
          <div className="dash-card-head">
            <h2 className="dash-card-title">Sessions</h2>
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

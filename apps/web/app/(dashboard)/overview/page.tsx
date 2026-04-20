import { computeMonthlyDelta } from "@bematist/embed";
import { brand } from "@bematist/ui/brand";
import type { Metadata } from "next";
import { CostDeltaTile } from "@/components/dashboard/CostDeltaTile";
import { NoSessionsEmpty } from "@/components/dashboard/EmptyState";
import { formatInt, formatTokens, formatUsd, monthKey } from "@/components/dashboard/format";
import { orgScopedDb } from "@/components/dashboard/orgDb";
import { getOverviewCounts, listDevelopers, listSessions } from "@/components/dashboard/queries";
import { SessionRow, SessionTableHeader } from "@/components/dashboard/SessionRow";
import { StatTile } from "@/components/dashboard/StatTile";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = {
  title: `Overview — ${brand.name}`,
  description: "Per-developer AI-coding telemetry overview.",
};

async function teamDelta(
  orgId: string,
  devIds: string[],
  month: Date,
): Promise<{
  actual: number;
  subscription: number;
  delta: number;
}> {
  if (devIds.length === 0) return { actual: 0, subscription: 0, delta: 0 };
  const db = orgScopedDb(orgId);
  let actual = 0;
  let subscription = 0;
  for (const id of devIds) {
    const r = await computeMonthlyDelta(db, id, month);
    actual += r.actualUsd;
    subscription += r.subscriptionUsd;
  }
  return {
    actual: Math.round(actual * 1e6) / 1e6,
    subscription: Math.round(subscription * 1e6) / 1e6,
    delta: Math.round((actual - subscription) * 1e6) / 1e6,
  };
}

export default async function DashboardOverview() {
  const session = await requireSession();
  const now = new Date();
  const [counts, devs, sessions] = await Promise.all([
    getOverviewCounts(session.org.id, now),
    listDevelopers(session.org.id, now),
    listSessions(session.org.id, { limit: 8 }),
  ]);

  const devIds = devs.map((d) => d.id);
  const delta = await teamDelta(session.org.id, devIds, now);

  return (
    <>
      <header className="dash-page-head">
        <span className="mk-sys">Overview</span>
        <h1 className="dash-page-title">{session.org.name}</h1>
        <p className="dash-page-subtitle">
          Per-developer AI-coding telemetry for {monthKey(now)}. The delta shows what your team
          would have paid on direct API pricing minus fixed subscription totals.
        </p>
      </header>

      <section
        aria-label="Cost delta"
        className="dash-tiles"
        style={{ gridTemplateColumns: "1fr" }}
      >
        <CostDeltaTile
          actualUsd={delta.actual}
          subscriptionUsd={delta.subscription}
          deltaUsd={delta.delta}
          month={monthKey(now)}
          subjectLabel={session.org.name}
        />
      </section>

      <section aria-label="This month" className="dash-tiles">
        <StatTile
          label="This month · cost"
          value={formatUsd(counts.totalCostUsd)}
          caption={`API-equivalent spend across ${formatInt(counts.activeDeveloperCount)} active developer${counts.activeDeveloperCount === 1 ? "" : "s"}`}
          index={0}
        />
        <StatTile
          label="Sessions"
          value={formatInt(counts.sessionCount)}
          caption={`${formatInt(counts.eventCount)} events recorded`}
          index={1}
        />
        <StatTile
          label="Tokens"
          value={formatTokens(counts.totalTokensInput + counts.totalTokensOutput)}
          caption={`${formatTokens(counts.totalTokensInput)} in · ${formatTokens(counts.totalTokensOutput)} out`}
          index={2}
        />
        <StatTile
          label="Merged PRs"
          value={formatInt(counts.mergedPrCount)}
          caption={`${monthKey(now)} · linked via webhook`}
          index={3}
        />
      </section>

      <section aria-label="Recent sessions">
        <div className="dash-card">
          <div className="dash-card-head">
            <h2 className="dash-card-title">Recent sessions</h2>
            <span className="dash-card-sub">Last {sessions.length}</span>
          </div>
          {sessions.length === 0 ? (
            <div style={{ padding: 24 }}>
              <NoSessionsEmpty />
            </div>
          ) : (
            <table className="dash-table">
              <SessionTableHeader />
              <tbody>
                {sessions.map((s) => (
                  <SessionRow key={s.id} session={s} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}

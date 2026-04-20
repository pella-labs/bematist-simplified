import type { DrizzleDb, OrgScopedDb } from "@bematist/db";
import { developers, events } from "@bematist/db/schema";
import { and, eq, gte, lt } from "drizzle-orm";
import { getSubscriptionMonthlyUsd } from "./cost";

export interface MonthlyDelta {
  actualUsd: number;
  subscriptionUsd: number;
  deltaUsd: number;
}

function monthWindow(month: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const end = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
  return { start, end };
}

async function loadDeveloper(
  tx: DrizzleDb,
  developerId: string,
): Promise<{
  orgId: string;
  subscriptionClaude: string | null;
  subscriptionCodex: string | null;
  subscriptionCursor: string | null;
} | null> {
  const rows = await tx
    .select({
      orgId: developers.orgId,
      subscriptionClaude: developers.subscriptionClaude,
      subscriptionCodex: developers.subscriptionCodex,
      subscriptionCursor: developers.subscriptionCursor,
    })
    .from(developers)
    .where(eq(developers.id, developerId))
    .limit(1);
  return rows[0] ?? null;
}

async function sumActualCost(tx: DrizzleDb, developerId: string, month: Date): Promise<number> {
  const { start, end } = monthWindow(month);
  const rows = await tx
    .select({ costUsd: events.costUsd })
    .from(events)
    .where(and(eq(events.developerId, developerId), gte(events.ts, start), lt(events.ts, end)));
  let total = 0;
  for (const r of rows) {
    if (r.costUsd == null) continue;
    const n = Number(r.costUsd);
    if (Number.isFinite(n)) total += n;
  }
  return Math.round(total * 1e6) / 1e6;
}

function subscriptionTotal(dev: {
  subscriptionClaude: string | null;
  subscriptionCodex: string | null;
  subscriptionCursor: string | null;
}): number {
  return (
    getSubscriptionMonthlyUsd(dev.subscriptionClaude) +
    getSubscriptionMonthlyUsd(dev.subscriptionCodex) +
    getSubscriptionMonthlyUsd(dev.subscriptionCursor)
  );
}

export async function computeMonthlyDelta(
  db: OrgScopedDb,
  developerId: string,
  month: Date,
): Promise<MonthlyDelta> {
  return db.withOrg(async (tx) => {
    const dev = await loadDeveloper(tx, developerId);
    if (!dev) return { actualUsd: 0, subscriptionUsd: 0, deltaUsd: 0 };
    const actualUsd = await sumActualCost(tx, developerId, month);
    const subscriptionUsd = subscriptionTotal(dev);
    const deltaUsd = Math.round((actualUsd - subscriptionUsd) * 1e6) / 1e6;
    return { actualUsd, subscriptionUsd, deltaUsd };
  });
}

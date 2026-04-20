import {
  developers,
  events,
  githubCommits,
  githubPrs,
  ingestKeys,
  promptClusters,
  prompts,
  repos,
  sessionCommitLinks,
  sessions,
  users,
} from "@bematist/db/schema";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { withOrgScope } from "./orgDb";

export interface OverviewCounts {
  totalCostUsd: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  sessionCount: number;
  eventCount: number;
  mergedPrCount: number;
  activeDeveloperCount: number;
}

export interface DeveloperSummary {
  id: string;
  name: string | null;
  email: string;
  userId: string | null;
  subscriptionClaude: string | null;
  subscriptionCodex: string | null;
  subscriptionCursor: string | null;
  sessionCount: number;
  monthlyCostUsd: number;
}

export interface SessionListItem {
  id: string;
  developerId: string;
  developerName: string | null;
  developerEmail: string;
  source: "claude-code" | "codex" | "cursor";
  startedAt: Date;
  endedAt: Date | null;
  cwd: string | null;
  gitBranch: string | null;
  costUsd: number;
  tokensInput: number;
  tokensOutput: number;
  eventCount: number;
  modelHint: string | null;
  clientVersion: string | null;
  signals: Array<"cwd_time" | "trailer" | "webhook_scan">;
  commitCount: number;
}

export interface SessionDetail extends SessionListItem {
  sourceSessionId: string;
  gitShaAtStart: string | null;
  transcript: TranscriptItem[];
  commits: LinkedCommit[];
}

export interface TranscriptItem {
  id: string;
  eventSeq: number;
  ts: Date;
  kind:
    | "user_prompt"
    | "assistant_response"
    | "tool_call"
    | "tool_result"
    | "session_start"
    | "session_end";
  toolName: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  durationMs: number | null;
  promptText: string | null;
  promptId: string | null;
  clusterId: string | null;
}

export interface LinkedCommit {
  sha: string;
  repoName: string | null;
  branch: string | null;
  committedAt: Date | null;
  authorLogin: string | null;
  message: string | null;
  signals: Array<"cwd_time" | "trailer" | "webhook_scan">;
  prNumber: number | null;
  prTitle: string | null;
  prMergedAt: Date | null;
}

export interface PromptClusterSummary {
  clusterId: string | null;
  label: string | null;
  promptCount: number;
  sessionCount: number;
  mergedSessionCount: number;
  avgCostUsd: number;
  exampleText: string | null;
}

export interface IngestKeyRow {
  id: string;
  developerId: string;
  developerName: string | null;
  developerEmail: string;
  createdAt: Date;
  revokedAt: Date | null;
}

function monthWindow(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

function toNumber(value: unknown): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function getOverviewCounts(
  orgId: string,
  now: Date = new Date(),
): Promise<OverviewCounts> {
  const { start, end } = monthWindow(now);
  return withOrgScope(orgId, async (tx) => {
    const aggRows = await tx
      .select({
        totalCost: sql<string>`coalesce(sum(${events.costUsd}), 0)`,
        totalIn: sql<string>`coalesce(sum(${events.inputTokens}), 0)`,
        totalOut: sql<string>`coalesce(sum(${events.outputTokens}), 0)`,
        eventCount: sql<string>`count(*)`,
      })
      .from(events)
      .where(and(gte(events.ts, start), lt(events.ts, end)));

    const sessionCountRows = await tx
      .select({ count: sql<string>`count(*)` })
      .from(sessions)
      .where(and(gte(sessions.startedAt, start), lt(sessions.startedAt, end)));

    const mergedPrRows = await tx
      .select({ count: sql<string>`count(*)` })
      .from(githubPrs)
      .where(and(gte(githubPrs.mergedAt, start), lt(githubPrs.mergedAt, end)));

    const activeDevRows = await tx
      .select({ developerId: sessions.developerId })
      .from(sessions)
      .where(and(gte(sessions.startedAt, start), lt(sessions.startedAt, end)))
      .groupBy(sessions.developerId);

    const agg = aggRows[0] ?? { totalCost: "0", totalIn: "0", totalOut: "0", eventCount: "0" };
    return {
      totalCostUsd: toNumber(agg.totalCost),
      totalTokensInput: toNumber(agg.totalIn),
      totalTokensOutput: toNumber(agg.totalOut),
      eventCount: toNumber(agg.eventCount),
      sessionCount: toNumber(sessionCountRows[0]?.count ?? 0),
      mergedPrCount: toNumber(mergedPrRows[0]?.count ?? 0),
      activeDeveloperCount: activeDevRows.length,
    };
  });
}

export async function listDevelopers(
  orgId: string,
  now: Date = new Date(),
): Promise<DeveloperSummary[]> {
  const { start, end } = monthWindow(now);
  return withOrgScope(orgId, async (tx) => {
    const devRows = await tx
      .select({
        id: developers.id,
        name: developers.name,
        email: developers.email,
        userId: developers.userId,
        subscriptionClaude: developers.subscriptionClaude,
        subscriptionCodex: developers.subscriptionCodex,
        subscriptionCursor: developers.subscriptionCursor,
      })
      .from(developers)
      .orderBy(asc(developers.name), asc(developers.email));

    if (devRows.length === 0) return [];

    const devIds = devRows.map((d) => d.id);

    const sessionCounts = await tx
      .select({
        developerId: sessions.developerId,
        count: sql<string>`count(*)`,
      })
      .from(sessions)
      .where(inArray(sessions.developerId, devIds))
      .groupBy(sessions.developerId);

    const sessionCountByDev = new Map<string, number>();
    for (const row of sessionCounts) {
      sessionCountByDev.set(row.developerId, toNumber(row.count));
    }

    const costRows = await tx
      .select({
        developerId: events.developerId,
        total: sql<string>`coalesce(sum(${events.costUsd}), 0)`,
      })
      .from(events)
      .where(and(inArray(events.developerId, devIds), gte(events.ts, start), lt(events.ts, end)))
      .groupBy(events.developerId);

    const costByDev = new Map<string, number>();
    for (const row of costRows) {
      costByDev.set(row.developerId, toNumber(row.total));
    }

    return devRows.map((d) => ({
      id: d.id,
      name: d.name,
      email: d.email,
      userId: d.userId,
      subscriptionClaude: d.subscriptionClaude,
      subscriptionCodex: d.subscriptionCodex,
      subscriptionCursor: d.subscriptionCursor,
      sessionCount: sessionCountByDev.get(d.id) ?? 0,
      monthlyCostUsd: costByDev.get(d.id) ?? 0,
    }));
  });
}

export async function getDeveloper(
  orgId: string,
  developerId: string,
): Promise<DeveloperSummary | null> {
  const all = await listDevelopers(orgId);
  return all.find((d) => d.id === developerId) ?? null;
}

export async function findDeveloperForUser(
  orgId: string,
  userId: string,
  email: string,
): Promise<DeveloperSummary | null> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ id: developers.id })
      .from(developers)
      .where(eq(developers.userId, userId))
      .limit(1);
    if (rows[0]) {
      return getDeveloper(orgId, rows[0].id);
    }
    const byEmail = await tx
      .select({ id: developers.id })
      .from(developers)
      .where(eq(developers.email, email))
      .limit(1);
    if (byEmail[0]) {
      return getDeveloper(orgId, byEmail[0].id);
    }
    return null;
  });
}

export interface SessionFilters {
  developerId?: string;
  source?: "claude-code" | "codex" | "cursor";
  limit?: number;
}

export async function listSessions(
  orgId: string,
  filters: SessionFilters = {},
): Promise<SessionListItem[]> {
  const limit = Math.min(filters.limit ?? 50, 200);
  return withOrgScope(orgId, async (tx) => {
    const conditions = [] as Array<ReturnType<typeof eq>>;
    if (filters.developerId) conditions.push(eq(sessions.developerId, filters.developerId));
    if (filters.source) conditions.push(eq(sessions.source, filters.source));

    const baseQuery = tx
      .select({
        id: sessions.id,
        developerId: sessions.developerId,
        developerName: developers.name,
        developerEmail: developers.email,
        source: sessions.source,
        startedAt: sessions.startedAt,
        endedAt: sessions.endedAt,
        cwd: sessions.cwd,
        gitBranch: sessions.gitBranch,
        modelHint: sessions.modelHint,
        clientVersion: sessions.clientVersion,
      })
      .from(sessions)
      .innerJoin(developers, eq(sessions.developerId, developers.id));

    const sessRows = await (conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery)
      .orderBy(desc(sessions.startedAt))
      .limit(limit);

    if (sessRows.length === 0) return [];

    const sessionIds = sessRows.map((r) => r.id);

    const aggRows = await tx
      .select({
        sessionId: events.sessionId,
        cost: sql<string>`coalesce(sum(${events.costUsd}), 0)`,
        tokIn: sql<string>`coalesce(sum(${events.inputTokens}), 0)`,
        tokOut: sql<string>`coalesce(sum(${events.outputTokens}), 0)`,
        eventCount: sql<string>`count(*)`,
      })
      .from(events)
      .where(inArray(events.sessionId, sessionIds))
      .groupBy(events.sessionId);

    const aggBySession = new Map<string, (typeof aggRows)[number]>();
    for (const row of aggRows) aggBySession.set(row.sessionId, row);

    const linkRows = await tx
      .select({
        sessionId: sessionCommitLinks.sessionId,
        commitSha: sessionCommitLinks.commitSha,
        signal: sessionCommitLinks.signal,
      })
      .from(sessionCommitLinks)
      .where(inArray(sessionCommitLinks.sessionId, sessionIds));

    const signalsBySession = new Map<string, Set<"cwd_time" | "trailer" | "webhook_scan">>();
    const commitsBySession = new Map<string, Set<string>>();
    for (const row of linkRows) {
      if (!signalsBySession.has(row.sessionId)) signalsBySession.set(row.sessionId, new Set());
      signalsBySession.get(row.sessionId)!.add(row.signal);
      if (!commitsBySession.has(row.sessionId)) commitsBySession.set(row.sessionId, new Set());
      commitsBySession.get(row.sessionId)!.add(row.commitSha);
    }

    return sessRows.map((r) => {
      const agg = aggBySession.get(r.id);
      return {
        id: r.id,
        developerId: r.developerId,
        developerName: r.developerName,
        developerEmail: r.developerEmail,
        source: r.source,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        cwd: r.cwd,
        gitBranch: r.gitBranch,
        costUsd: toNumber(agg?.cost),
        tokensInput: toNumber(agg?.tokIn),
        tokensOutput: toNumber(agg?.tokOut),
        eventCount: toNumber(agg?.eventCount),
        modelHint: r.modelHint,
        clientVersion: r.clientVersion,
        signals: Array.from(signalsBySession.get(r.id) ?? new Set()),
        commitCount: (commitsBySession.get(r.id) ?? new Set()).size,
      };
    });
  });
}

export async function getSessionDetail(
  orgId: string,
  sessionId: string,
): Promise<SessionDetail | null> {
  const items = await listSessions(orgId, { limit: 200 });
  const base = items.find((s) => s.id === sessionId) ?? null;
  if (!base) {
    const fallback = await listSessions(orgId, { limit: 200 });
    if (!fallback.find((s) => s.id === sessionId)) return null;
  }

  return withOrgScope(orgId, async (tx) => {
    const sessRow = await tx
      .select({
        id: sessions.id,
        developerId: sessions.developerId,
        developerName: developers.name,
        developerEmail: developers.email,
        source: sessions.source,
        sourceSessionId: sessions.sourceSessionId,
        startedAt: sessions.startedAt,
        endedAt: sessions.endedAt,
        cwd: sessions.cwd,
        gitBranch: sessions.gitBranch,
        gitShaAtStart: sessions.gitShaAtStart,
        modelHint: sessions.modelHint,
        clientVersion: sessions.clientVersion,
      })
      .from(sessions)
      .innerJoin(developers, eq(sessions.developerId, developers.id))
      .where(eq(sessions.id, sessionId))
      .limit(1);

    const sr = sessRow[0];
    if (!sr) return null;

    const eventRows = await tx
      .select({
        id: events.id,
        eventSeq: events.eventSeq,
        ts: events.ts,
        kind: events.kind,
        toolName: events.toolName,
        costUsd: events.costUsd,
        inputTokens: events.inputTokens,
        outputTokens: events.outputTokens,
        cacheReadTokens: events.cacheReadTokens,
        cacheCreationTokens: events.cacheCreationTokens,
        durationMs: events.durationMs,
        promptId: events.promptId,
      })
      .from(events)
      .where(eq(events.sessionId, sessionId))
      .orderBy(asc(events.eventSeq));

    const promptIds = eventRows.map((e) => e.promptId).filter((p): p is string => p !== null);

    const promptRows =
      promptIds.length > 0
        ? await tx
            .select({
              id: prompts.id,
              promptText: prompts.promptText,
              clusterId: prompts.clusterId,
            })
            .from(prompts)
            .where(inArray(prompts.id, promptIds))
        : [];

    const promptById = new Map<string, (typeof promptRows)[number]>();
    for (const p of promptRows) promptById.set(p.id, p);

    const transcript: TranscriptItem[] = eventRows.map((e) => {
      const prompt = e.promptId ? promptById.get(e.promptId) : undefined;
      return {
        id: e.id,
        eventSeq: e.eventSeq,
        ts: e.ts,
        kind: e.kind,
        toolName: e.toolName,
        costUsd: e.costUsd == null ? null : toNumber(e.costUsd),
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        cacheReadTokens: e.cacheReadTokens,
        cacheCreationTokens: e.cacheCreationTokens,
        durationMs: e.durationMs,
        promptText: prompt?.promptText ?? null,
        promptId: e.promptId,
        clusterId: prompt?.clusterId ?? null,
      };
    });

    const linkRows = await tx
      .select({
        commitSha: sessionCommitLinks.commitSha,
        signal: sessionCommitLinks.signal,
      })
      .from(sessionCommitLinks)
      .where(eq(sessionCommitLinks.sessionId, sessionId));

    const signalsByCommit = new Map<string, Set<"cwd_time" | "trailer" | "webhook_scan">>();
    for (const l of linkRows) {
      if (!signalsByCommit.has(l.commitSha)) signalsByCommit.set(l.commitSha, new Set());
      signalsByCommit.get(l.commitSha)!.add(l.signal);
    }
    const commitShas = Array.from(signalsByCommit.keys());

    const commitDetails: LinkedCommit[] =
      commitShas.length === 0
        ? []
        : await (async (): Promise<LinkedCommit[]> => {
            const cRows = await tx
              .select({
                sha: githubCommits.sha,
                repoName: repos.name,
                branch: githubCommits.branch,
                committedAt: githubCommits.committedAt,
                authorLogin: githubCommits.authorGithubLogin,
                message: githubCommits.message,
                prId: githubCommits.prId,
                prNumber: githubPrs.number,
                prTitle: githubPrs.title,
                prMergedAt: githubPrs.mergedAt,
              })
              .from(githubCommits)
              .leftJoin(repos, eq(githubCommits.repoId, repos.id))
              .leftJoin(githubPrs, eq(githubCommits.prId, githubPrs.id))
              .where(inArray(githubCommits.sha, commitShas));
            const commitMap = new Map<string, (typeof cRows)[number]>();
            for (const c of cRows) commitMap.set(c.sha, c);
            return commitShas.map((sha) => {
              const c = commitMap.get(sha);
              return {
                sha,
                repoName: c?.repoName ?? null,
                branch: c?.branch ?? null,
                committedAt: c?.committedAt ?? null,
                authorLogin: c?.authorLogin ?? null,
                message: c?.message ?? null,
                signals: Array.from(signalsByCommit.get(sha) ?? new Set()),
                prNumber: c?.prNumber ?? null,
                prTitle: c?.prTitle ?? null,
                prMergedAt: c?.prMergedAt ?? null,
              };
            });
          })();

    const eventAgg = eventRows.reduce(
      (acc, e) => {
        if (e.costUsd != null) acc.cost += toNumber(e.costUsd);
        acc.tokIn += toNumber(e.inputTokens);
        acc.tokOut += toNumber(e.outputTokens);
        return acc;
      },
      { cost: 0, tokIn: 0, tokOut: 0 },
    );

    return {
      id: sr.id,
      developerId: sr.developerId,
      developerName: sr.developerName,
      developerEmail: sr.developerEmail,
      source: sr.source,
      sourceSessionId: sr.sourceSessionId,
      startedAt: sr.startedAt,
      endedAt: sr.endedAt,
      cwd: sr.cwd,
      gitBranch: sr.gitBranch,
      gitShaAtStart: sr.gitShaAtStart,
      modelHint: sr.modelHint,
      clientVersion: sr.clientVersion,
      costUsd: eventAgg.cost,
      tokensInput: eventAgg.tokIn,
      tokensOutput: eventAgg.tokOut,
      eventCount: eventRows.length,
      signals: Array.from(new Set(linkRows.map((l) => l.signal))),
      commitCount: commitShas.length,
      transcript,
      commits: commitDetails,
    };
  });
}

export async function listPromptClusters(orgId: string): Promise<PromptClusterSummary[]> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        clusterId: prompts.clusterId,
        promptCount: sql<string>`count(*)`,
        sessionCount: sql<string>`count(distinct ${prompts.sessionId})`,
        exampleText: sql<string>`min(${prompts.promptText})`,
      })
      .from(prompts)
      .groupBy(prompts.clusterId);

    if (rows.length === 0) return [];

    const clusterIds = rows.map((r) => r.clusterId).filter((c): c is string => c !== null);

    const labelRows =
      clusterIds.length > 0
        ? await tx
            .select({
              id: promptClusters.id,
              label: promptClusters.label,
            })
            .from(promptClusters)
            .where(inArray(promptClusters.id, clusterIds))
        : [];
    const labelById = new Map<string, string | null>();
    for (const l of labelRows) labelById.set(l.id, l.label);

    const mergedAgg = await tx
      .select({
        clusterId: prompts.clusterId,
        mergedCount: sql<string>`count(distinct ${githubPrs.id})`,
      })
      .from(prompts)
      .innerJoin(sessions, eq(prompts.sessionId, sessions.id))
      .innerJoin(sessionCommitLinks, eq(sessionCommitLinks.sessionId, sessions.id))
      .innerJoin(githubCommits, eq(sessionCommitLinks.commitSha, githubCommits.sha))
      .innerJoin(githubPrs, eq(githubCommits.prId, githubPrs.id))
      .groupBy(prompts.clusterId);

    const mergedByCluster = new Map<string | null, number>();
    for (const r of mergedAgg) mergedByCluster.set(r.clusterId, toNumber(r.mergedCount));

    const costAgg = await tx
      .select({
        clusterId: prompts.clusterId,
        costAvg: sql<string>`coalesce(avg(${events.costUsd}), 0)`,
      })
      .from(prompts)
      .leftJoin(events, eq(events.promptId, prompts.id))
      .groupBy(prompts.clusterId);

    const costByCluster = new Map<string | null, number>();
    for (const r of costAgg) costByCluster.set(r.clusterId, toNumber(r.costAvg));

    return rows.map((r) => ({
      clusterId: r.clusterId,
      label: r.clusterId ? (labelById.get(r.clusterId) ?? null) : null,
      promptCount: toNumber(r.promptCount),
      sessionCount: toNumber(r.sessionCount),
      mergedSessionCount: mergedByCluster.get(r.clusterId) ?? 0,
      avgCostUsd: costByCluster.get(r.clusterId) ?? 0,
      exampleText: r.exampleText ?? null,
    }));
  });
}

export async function listIngestKeys(orgId: string): Promise<IngestKeyRow[]> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: ingestKeys.id,
        developerId: ingestKeys.developerId,
        developerName: developers.name,
        developerEmail: developers.email,
        createdAt: ingestKeys.createdAt,
        revokedAt: ingestKeys.revokedAt,
      })
      .from(ingestKeys)
      .innerJoin(developers, eq(ingestKeys.developerId, developers.id))
      .orderBy(desc(ingestKeys.createdAt));
    return rows;
  });
}

export async function getMyDeveloper(
  orgId: string,
  userId: string,
  email: string,
): Promise<DeveloperSummary | null> {
  return findDeveloperForUser(orgId, userId, email);
}

export async function listUsers(
  orgId: string,
): Promise<Array<{ id: string; email: string; name: string | null; role: "admin" | "member" }>> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ id: users.id, email: users.email, name: users.name, role: users.role })
      .from(users)
      .orderBy(asc(users.name), asc(users.email));
    return rows.map((r) => ({ ...r, role: r.role as "admin" | "member" }));
  });
}

export interface CompareItem {
  kind: "session" | "cluster";
  id: string;
  label: string;
  subtitle: string | null;
  costUsd: number;
  tokensInput: number;
  tokensOutput: number;
  eventCount: number;
  clusterId: string | null;
  mergedCommitCount: number;
}

export async function getCompareItem(
  orgId: string,
  kind: "session" | "cluster",
  id: string,
): Promise<CompareItem | null> {
  if (kind === "session") {
    const s = await getSessionDetail(orgId, id);
    if (!s) return null;
    const firstPromptCluster = s.transcript.find((t) => t.clusterId !== null)?.clusterId ?? null;
    return {
      kind: "session",
      id: s.id,
      label: s.developerName ?? s.developerEmail,
      subtitle: `${s.source} · ${s.startedAt.toISOString().slice(0, 16).replace("T", " ")}`,
      costUsd: s.costUsd,
      tokensInput: s.tokensInput,
      tokensOutput: s.tokensOutput,
      eventCount: s.eventCount,
      clusterId: firstPromptCluster,
      mergedCommitCount: s.commits.filter((c) => c.prMergedAt != null).length,
    };
  }
  const clusters = await listPromptClusters(orgId);
  const c = clusters.find((cl) => cl.clusterId === id);
  if (!c) return null;
  return {
    kind: "cluster",
    id,
    label: c.label ?? (c.exampleText ? c.exampleText.slice(0, 60) : "Cluster"),
    subtitle: `${c.promptCount} prompts · ${c.sessionCount} sessions`,
    costUsd: c.avgCostUsd * c.promptCount,
    tokensInput: 0,
    tokensOutput: 0,
    eventCount: c.promptCount,
    clusterId: c.clusterId,
    mergedCommitCount: c.mergedSessionCount,
  };
}

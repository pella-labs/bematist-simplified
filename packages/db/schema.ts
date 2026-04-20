import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

export const orgs = pgTable("orgs", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    betterAuthUserId: text("better_auth_user_id").notNull(),
    email: text("email").notNull(),
    name: text("name"),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("users_better_auth_user_id_uq").on(t.betterAuthUserId),
    uniqueIndex("users_org_email_uq").on(t.orgId, t.email),
  ],
);

export const developers = pgTable(
  "developers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    name: text("name"),
    subscriptionClaude: text("subscription_claude"),
    subscriptionCodex: text("subscription_codex"),
    subscriptionCursor: text("subscription_cursor"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("developers_org_email_uq").on(t.orgId, t.email)],
);

export const ingestKeys = pgTable(
  "ingest_keys",
  {
    id: text("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    developerId: uuid("developer_id")
      .notNull()
      .references(() => developers.id, { onDelete: "cascade" }),
    keySha256: text("key_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("ingest_keys_developer_idx").on(t.developerId)],
);

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" }).notNull().unique(),
    webhookSecret: text("webhook_secret"),
    tokenRef: text("token_ref"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("github_installations_org_idx").on(t.orgId)],
);

export const repos = pgTable(
  "repos",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull().unique(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("repos_org_idx").on(t.orgId)],
);

export const githubPrs = pgTable(
  "github_prs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    authorGithubLogin: text("author_github_login"),
    state: text("state").notNull(),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    baseSha: text("base_sha"),
    headSha: text("head_sha"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("github_prs_repo_number_uq").on(t.repoId, t.number),
    index("github_prs_org_idx").on(t.orgId),
  ],
);

export const githubCommits = pgTable(
  "github_commits",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    authorEmail: text("author_email"),
    authorGithubLogin: text("author_github_login"),
    message: text("message"),
    branch: text("branch"),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    prId: uuid("pr_id").references(() => githubPrs.id, { onDelete: "set null" }),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.sha] }),
    index("github_commits_org_idx").on(t.orgId),
    index("github_commits_committed_at_idx").on(t.committedAt),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    developerId: uuid("developer_id")
      .notNull()
      .references(() => developers.id, { onDelete: "cascade" }),
    source: text("source", { enum: ["claude-code", "codex", "cursor"] }).notNull(),
    sourceSessionId: text("source_session_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    cwd: text("cwd"),
    gitBranch: text("git_branch"),
    gitShaAtStart: text("git_sha_at_start"),
    modelHint: text("model_hint"),
    clientVersion: text("client_version"),
  },
  (t) => [
    uniqueIndex("sessions_org_source_source_session_uq").on(t.orgId, t.source, t.sourceSessionId),
    index("sessions_developer_started_at_idx").on(t.developerId, t.startedAt),
  ],
);

// events is partitioned by ts (monthly). Drizzle cannot express PARTITION BY,
// so the DDL lives in migrations/0002_partitions.sql. The schema below is used
// for query typing only.
export const events = pgTable(
  "events",
  {
    id: uuid("id").defaultRandom().notNull(),
    orgId: uuid("org_id").notNull(),
    developerId: uuid("developer_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    eventSeq: integer("event_seq").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    kind: text("kind", {
      enum: [
        "user_prompt",
        "assistant_response",
        "tool_call",
        "tool_result",
        "session_start",
        "session_end",
      ],
    }).notNull(),
    toolName: text("tool_name"),
    toolInput: jsonb("tool_input"),
    toolOutput: jsonb("tool_output"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheCreationTokens: integer("cache_creation_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    durationMs: integer("duration_ms"),
    success: boolean("success"),
    raw: jsonb("raw"),
    promptId: uuid("prompt_id"),
    clientEventId: uuid("client_event_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.ts] }),
    uniqueIndex("events_dedup_uq").on(t.orgId, t.sessionId, t.eventSeq, t.clientEventId, t.ts),
    index("events_session_ts_idx").on(t.sessionId, t.ts),
  ],
);

// prompts is partitioned by created_at (monthly). See migrations/0002_partitions.sql.
export const prompts = pgTable(
  "prompts",
  {
    id: uuid("id").defaultRandom().notNull(),
    orgId: uuid("org_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    promptIndex: integer("prompt_index").notNull(),
    promptText: text("prompt_text").notNull(),
    promptSha256: text("prompt_sha256").notNull(),
    embedding: vector("embedding", { dimensions: 384 }),
    clusterId: uuid("cluster_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index("prompts_session_idx").on(t.sessionId, t.promptIndex),
    index("prompts_sha256_idx").on(t.promptSha256),
  ],
);

export const promptClusters = pgTable("prompt_clusters", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" }),
  centroid: vector("centroid", { dimensions: 384 }),
  size: integer("size").notNull().default(0),
  label: text("label"),
  computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sessionCommitLinks = pgTable(
  "session_commit_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    signal: text("signal", { enum: ["cwd_time", "trailer", "webhook_scan"] }).notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("session_commit_links_uq").on(t.sessionId, t.commitSha, t.signal),
    index("session_commit_links_commit_idx").on(t.commitSha),
  ],
);

export const pricing = pgTable(
  "pricing",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pricingVersion: text("pricing_version").notNull(),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    inputPerMtok: numeric("input_per_mtok", { precision: 10, scale: 4 }),
    outputPerMtok: numeric("output_per_mtok", { precision: 10, scale: 4 }),
    cacheReadPerMtok: numeric("cache_read_per_mtok", { precision: 10, scale: 4 }),
    cacheWritePerMtok: numeric("cache_write_per_mtok", { precision: 10, scale: 4 }),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("pricing_version_model_from_uq").on(t.pricingVersion, t.model, t.effectiveFrom),
    index("pricing_model_idx").on(t.model),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    installationId: bigint("installation_id", { mode: "number" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("webhook_deliveries_received_at_idx").on(t.receivedAt)],
);

export const orgScopedTables = [
  "users",
  "developers",
  "ingest_keys",
  "github_installations",
  "repos",
  "github_prs",
  "github_commits",
  "sessions",
  "events",
  "prompts",
  "prompt_clusters",
  "session_commit_links",
] as const;

export const SCHEMA_MARKER = sql`/* bematist schema */`;

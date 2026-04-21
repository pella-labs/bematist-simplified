# Bematist Simplified — Implementation Plan

## Goal

Prove end-to-end that we can (1) capture AI-coding telemetry from Claude Code, Codex CLI, and Cursor on a developer's machine, (2) link those sessions to the git commits and merged PRs they produced, and (3) surface — per developer, with their real name — prompt/outcome patterns and the dollar delta between their actual subscription spend and what the same tokens would have cost on API pricing.

Everything else is out of scope until this loop is working for our 5-person team in production.

## Success criteria

1. A developer on macOS, Linux, or Windows downloads one binary, logs in once, and their telemetry begins flowing without further configuration.
2. A manager signs up, installs the GitHub App on their org's repos, invites developers, and within 24 hours sees a dashboard with per-developer sessions, token counts, cost, and which sessions produced merged PRs.
3. Prompts are embedded and clustered so the dashboard can show "prompts like this one had a 60% merge rate" for any given session.
4. The ingest binary stays alive for 7 days of continuous use without crashing, losing events, or corrupting its local state.

## Architecture

```
Developer machine                         Railway (hosted)
┌────────────────────┐   HTTPS batch    ┌──────────────────────┐
│ bematist ingest    │ ───────────────> │ api (Bun.serve)      │
│  - claude-code tail│                  │  /v1/events          │
│  - codex tail      │                  │  /v1/webhooks/github │
│  - cursor hooks    │                  │  /v1/ingest-keys/... │
│  - git post-commit │                  └──────────┬───────────┘
│  - config in ~/.bematist                         │
└────────────────────┘                             │
                                                   ▼
GitHub.com                                ┌──────────────────────┐
  ┌────────────┐    webhook HMAC          │ postgres + pgvector  │
  │ GitHub App │ ──────────────────────>  │  orgs, users,        │
  │ (our app)  │                          │  repos, installations│
  └────────────┘                          │  sessions, events,   │
                                          │  prompts (embedding),│
                                          │  commits, prs        │
Developer browser                         └──────────┬───────────┘
  ┌────────────┐                                     │
  │ web        │ <── Better-Auth / GitHub OAuth ─────┤
  │ (Next 16)  │ <── Drizzle queries ────────────────┘
  └────────────┘
```

Four deployable units on Railway: `web`, `api`, `worker`, `postgres`. (No Redis. No Kafka. No ClickHouse.) Prompt/response blobs live inline in Postgres during dogfood; migrate to **Tigris** (S3-compatible, user already has an account) as a dedicated post-MVP workstream when event volume demands it.

## Data model

All tables have `org_id` (except `orgs`) and are RLS-protected by `current_setting('app.current_org_id')`. Event-scale tables are `PARTITION BY RANGE (created_at)` with monthly partitions.

**Relational core:**
- `orgs(id, slug, name, created_at)`
- `users(id, org_id, better_auth_user_id, email, name, role)` — role is `admin` or `member`. Every admin is also treated as a developer-view user.
- `developers(id, org_id, user_id nullable, email, name, subscription_claude, subscription_codex, subscription_cursor)` — one row per telemetry-emitting developer. `user_id` links to `users` when the developer also signs in to the dashboard (which most will — managers here are typically also engineers). Link is created automatically when a dashboard user's email matches an existing developer row, or a developer row's email matches an existing user.
- `ingest_keys(id PK text="bm_<orgId>_<rand>", org_id, developer_id, key_sha256, created_at, revoked_at)`
- `github_installations(id bigserial, org_id, installation_id bigint unique, webhook_secret, token_ref, status, created_at)`
- `repos(id, org_id, installation_id, github_repo_id bigint unique, name, default_branch, archived_at)`
- `github_prs(id, org_id, repo_id, number, title, author_github_login, state, merged_at, base_sha, head_sha, created_at)`
- `github_commits(id, org_id, repo_id, sha PK-composite, author_email, author_github_login, message, branch, committed_at, pushed_at, pr_id nullable)`

**Event/session core (partitioned):**
- `sessions(id, org_id, developer_id, source ENUM('claude-code','codex','cursor'), source_session_id, started_at, ended_at, cwd, git_branch, git_sha_at_start, model_hint, client_version)`
- `events(id, org_id, developer_id, session_id, event_seq, ts, kind ENUM('user_prompt','assistant_response','tool_call','tool_result','session_start','session_end'), tool_name, tool_input jsonb, tool_output jsonb, input_tokens int, output_tokens int, cache_read_tokens int, cache_creation_tokens int, cost_usd numeric, duration_ms int, success bool, raw jsonb, prompt_id nullable)` — partitioned by month on `ts`
- `prompts(id, org_id, session_id, prompt_index, prompt_text text, prompt_sha256, embedding vector(384), cluster_id nullable)` — MiniLM default, pgvector HNSW index on embedding
- `prompt_clusters(id, org_id, centroid vector(384), size, label)` — nightly re-cluster job

**Outcome attribution (all three signals stored, all time):**
- `session_commit_links(id, org_id, session_id, commit_sha, signal ENUM('cwd_time','trailer','webhook_scan'), confidence numeric, computed_at)` — a session/commit pair can have up to 3 rows, one per signal

**Pricing (pinned, versioned):**
- `pricing(id, pricing_version, model, provider, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, effective_from, effective_to)` — seeded at deploy from a JSON file committed in `packages/contracts/pricing/`

## Wire format

All event traffic uses a single Zod schema in `packages/contracts/src/event.ts`:

```ts
EventEnvelope = {
  client_event_id: uuid,      // dedup key
  schema_version: 1,
  developer_id: uuid,         // derived server-side from ingest key, not trusted from client
  session_id: string,         // source-assigned
  source_session_id: string,  // claude/codex/cursor's own id
  source: 'claude-code' | 'codex' | 'cursor',
  source_version: string,
  client_version: string,     // bematist binary version
  ts: iso8601,
  event_seq: int,
  kind: ...,                  // as in DB
  // payload fields — union by kind, Zod discriminated union
  payload: PromptPayload | ResponsePayload | ToolCallPayload | ...,
  cwd: string | null,
  git_branch: string | null,
  git_sha: string | null,
  model: string | null,
  usage: { input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens } | null,
  duration_ms: int | null,
  success: bool | null,
  raw: unknown,               // verbatim original record for forensics
}
```

Server derives `org_id` and `developer_id` from the ingest key, *ignoring* any such fields in the payload. Events are deduped on `(org_id, session_id, event_seq, client_event_id)` via Postgres `INSERT ... ON CONFLICT DO NOTHING`.

## Outcome attribution — three signals stored side-by-side

1. **`cwd_time`** — compare `sessions.cwd` against `repos` paths discovered via `git config --get remote.origin.url` (captured per session), and match commits by `committed_at` falling inside session `started_at`/`ended_at` ± 10 min.
2. **`trailer`** — the ingest binary installs a repo-local `post-commit` git hook that appends a `Bematist-Session: <session_id>` trailer to commit messages. Webhook handler parses it deterministically.
3. **`webhook_scan`** — on `push` webhook, look back N commits and match by `cwd+author+time` as fallback when neither of the above matched.

All three are stored in `session_commit_links`. Dashboard shows which signals matched for each link. First internal-dogfood retrospective decides which to trust long-term.

## Subscription-vs-API cost delta

- Every event's `cost_usd` is computed from `pricing` at insert time using the `source_version` + `model` to pick a row.
- `developers.subscription_claude|codex|cursor` is a free-text string (`max_200`, `pro_20`, `business`, `api_key`, null) populated on first ingest-binary run from best-effort credential-file inspection, with a dashboard override.
- Monthly tile per developer: `sum(cost_usd) for month` vs `subscription_total_usd_for_month`. Delta = `sum(cost_usd) - subscription_total`. Big positive delta → subscription is a bargain; negative → over-provisioned.

## Reuse from `../analytics-research/`

Only these files. Copy verbatim, strip all references to `tier`, `redaction`, `clio`, `scoring`:

| From | To | Purpose |
|---|---|---|
| `apps/collector/src/adapters/claude-code/parsers/parseSessionFile.ts` | `apps/ingest/src/adapters/claude-code/parseSessionFile.ts` | Hardened JSONL parser |
| `apps/web/lib/auth.ts` + `auth-bridge.ts` | `packages/auth/src/` | Better-Auth config + first-login bridge |
| `apps/ingest/src/github-app/webhookRoute.ts` | `apps/api/src/github/webhook.ts` | HMAC webhook handler |
| `apps/ingest/src/github-app/verifyWithRotation.ts` | `apps/api/src/github/verify.ts` | Dual-accept HMAC |
| `apps/ingest/src/github-app/installationResolver.ts` + `token-cache.ts` | `apps/api/src/github/install.ts` | Installation token minting |
| `apps/web/app/(marketing)/home/*` tree | `apps/web/app/(marketing)/*` | Landing page visual style (rewrite copy) |
| `packages/schema/postgres/custom/0002_rls_org_isolation.sql` | `packages/db/migrations/0002_rls.sql` | RLS policy pattern |

Everything else — rebuild minimally.

---

# Workstreams

Every workstream section below is the contract an `implementer` subagent will be given. Each lists: purpose, depends-on, files owned, deliverables, contract in/out, acceptance.

## Wave 0 — Foundation (serial, orchestrator-driven)

### WS-0: Monorepo scaffolding + Railway projects

**Purpose:** Stand up the empty repo so downstream workstreams have a place to commit.

**Depends on:** nothing.

**Files owned (creates):**
- `/package.json` (bun workspaces: `apps/*`, `packages/*`)
- `/tsconfig.base.json`, `/biome.json`, `/.gitignore`, `/.env.example`
- `/apps/web/` (Next.js 16 skeleton, `bun create next-app` stripped to bones)
- `/apps/api/` (empty `src/index.ts` with `Bun.serve({ port: 8000 })` returning 200 on `/health`)
- `/apps/ingest/` (empty `src/index.ts` with `console.log("bematist v0.0.0")`, `bun build --compile` target in scripts)
- `/apps/worker/` (empty `src/index.ts`)
- `/packages/contracts/` (bare package exporting `SCHEMA_VERSION = 1`)
- `/packages/db/` (Drizzle config + empty migrations dir)
- `/packages/ui/` (shadcn init, Tailwind v4 config, base tokens)
- `/packages/auth/` (bare package)
- `/packages/embed/` (bare package)
- `/docker-compose.yml` (postgres 16 with pgvector image, one service)
- `/README.md` (10 lines: what this is, how to boot locally)

**Deliverables:**
- `bun install` works from clean clone.
- `bun run dev` starts web on `:3000`, api on `:8000`, both reload on change.
- `docker compose up postgres` starts Postgres 16 with `pgvector` extension available.
- Initial git commit + push to **`github.com/pella-labs/bematist-simplified`** (public repo under the `pella-labs` org; orchestrator creates the repo before spawning this workstream, subagent just wires the remote and pushes).

**Contract out:** Workspace layout is fixed after this workstream merges. Changing it requires a new dedicated workstream.

**Acceptance:**
- `bun run typecheck` passes (all packages).
- `bun run lint` passes (biome).
- `curl localhost:8000/health` → `200 {"ok":true}`.

---

## Wave 1 — Parallel (7 workstreams, begin after WS-0 merged)

### WS-1: Postgres schema + Drizzle + RLS + pgvector

**Purpose:** Persist all relational + event + embedding data with tenant isolation enforced at the DB layer.

**Depends on:** WS-0.

**Files owned:**
- `/packages/db/schema.ts` (Drizzle schema for every table in the Data Model section)
- `/packages/db/migrations/*.sql` (Drizzle-generated + hand-written RLS + partitioning)
- `/packages/db/src/client.ts` (exports `getDb(orgId)` that sets `app.current_org_id` on each connection)
- `/packages/db/src/migrate.ts` (runner invoked by `bun run migrate`)
- `/packages/db/seed/pricing.json` (pinned pricing table)

**Deliverables:**
- All 14 tables from Data Model section created with correct types, FKs, indexes.
- RLS enabled on every org-scoped table with `USING (org_id::text = current_setting('app.current_org_id', true))`.
- `events` and `prompts` tables use native range partitioning by `ts` (monthly), with an automation function to create the next 3 months of partitions.
- pgvector HNSW index on `prompts.embedding`.
- Pricing JSON seeded.
- `bun run migrate` applies all migrations against `docker compose` Postgres cleanly from empty.
- Tests: RLS cross-tenant probe — insert rows for org A, query as org B, expect 0 rows, expect `INSERT` into org A from org-B context to fail.

**Contract out:** Drizzle types re-exported from `packages/db` are the source of truth for anything touching storage. Every downstream workstream imports from `@bematist/db`.

**Acceptance:** Test suite green, including `rls-cross-tenant.test.ts`, `partition-rolls-forward.test.ts`.

---

### WS-2: Ingest API skeleton + bearer auth + event write path

**Purpose:** Accept batched events over HTTP and write them to Postgres with full validation and tenant enforcement.

**Depends on:** WS-0, contract on `packages/contracts` (stub until WS-6 firms it up).

**Files owned:**
- `/apps/api/src/index.ts` (Bun.serve router)
- `/apps/api/src/routes/events.ts` (`POST /v1/events`)
- `/apps/api/src/routes/health.ts`
- `/apps/api/src/auth/verifyIngestKey.ts` (lookup by `(org_id, key_id)`, `timingSafeEqual` SHA256)
- `/apps/api/src/pipeline/validate.ts` (Zod parse via `packages/contracts`)
- `/apps/api/src/pipeline/insertEvents.ts` (batch insert with `ON CONFLICT DO NOTHING`, returns inserted count)
- `/apps/api/src/pipeline/cost.ts` (look up `pricing` by model + `source_version` window, compute `cost_usd` per event before insert)

**Deliverables:**
- `POST /v1/events` validates Zod envelope, rejects unknown fields, derives `developer_id`/`org_id` from bearer, computes cost, inserts, returns `{ accepted: n, deduped: n }`.
- Rate limiting is **not** in this workstream. Defer.
- Server refuses to start if `DATABASE_URL` missing.
- Tests: key-not-found (401), revoked-key (401), unknown field (400), valid batch inserts and ignores dup `client_event_id`, cost calc matches fixtures for Sonnet 4.6, Opus 4.7, gpt-5, cursor-sonnet.

**Contract out:** Event envelope Zod schema lives in `packages/contracts` and is the public contract for WS-6 (binary), WS-8/9/10 (adapters).

**Acceptance:** ≥12 tests, all pass. Ingests 10k fixture events in <2s locally.

---

### WS-3: Landing page (lift style from `../analytics-research`)

**Purpose:** Public marketing page at `/` and `/install`. Styling lifted from existing; copy rewritten.

**Depends on:** WS-0.

**Files owned:**
- `/apps/web/app/(marketing)/layout.tsx`
- `/apps/web/app/(marketing)/page.tsx` (home — hero, 3 feature cards, CTA)
- `/apps/web/app/(marketing)/install/page.tsx`
- `/apps/web/components/marketing/*` (ported from old repo, stripped of scoring/privacy references)
- `/packages/ui/src/brand.config.ts`

**Deliverables:**
- Pixel-similar layout to `../analytics-research/apps/web/app/(marketing)/home/`, using Tailwind v4 + shadcn.
- Copy matches the value prop: "Measure which prompts actually ship. See your team's AI coding ROI."
- No mention of compliance/privacy tiers/AI Leverage Score.
- Dark mode default, light mode via OS preference.
- Tests: basic Playwright smoke (`/` renders, hero visible, CTA links to `/auth/sign-in`).

**Contract out:** None downstream beyond visual tokens in `packages/ui/src/brand.config.ts`.

**Acceptance:** Smoke test green. Visual comparison against old marketing page shows same general feel.

---

### WS-4: Better-Auth + GitHub OAuth + org bootstrap

**Purpose:** Users sign in with GitHub, first user in a fresh session creates an org and becomes admin. Subsequent users via invite.

**Depends on:** WS-0, WS-1 (for `users`, `orgs` tables).

**Files owned:**
- `/packages/auth/src/server.ts` (Better-Auth config)
- `/packages/auth/src/bridge.ts` (on-first-signin → create org + user row + role)
- `/apps/web/app/api/auth/[...all]/route.ts`
- `/apps/web/app/auth/sign-in/page.tsx`
- `/apps/web/app/auth/sign-in/SignInClient.tsx`
- `/apps/web/app/post-auth/new-org/route.ts`
- `/apps/web/app/post-auth/accept-invite/route.ts`
- `/apps/web/lib/session.ts` (server helper that returns `{ user, org, role }`)

**Deliverables:**
- GitHub OAuth works against real github.com (scopes: `read:user`, `public_repo`).
- First login with no invite → prompt for org name → creates `orgs` + `users` with role=admin.
- Second login with invite token → joins org with role=member.
- Logged-in session stored in DB (Better-Auth adapter pointing at our Postgres).
- `app.current_org_id` set on every authenticated server-side query via `getDb(org.id)`.
- Tests: first user bootstraps admin, second via invite joins as member, cross-org read returns empty.

**Contract out:** `lib/session.ts` exports `requireSession()` that all dashboard server components import.

**Acceptance:** Full sign-in flow works in Playwright against local Postgres. RLS test passes.

---

### WS-5: GitHub App install flow + webhook receiver

**Purpose:** Admin installs our GitHub App, we persist installation, accept + verify webhooks, store repos/PRs/commits.

**Depends on:** WS-0, WS-1, WS-4.

**Files owned:**
- `/apps/api/src/github/webhook.ts` (HMAC verify + dispatch)
- `/apps/api/src/github/verify.ts` (dual-accept rotation)
- `/apps/api/src/github/install.ts` (installation token minting + cache — cache in memory for v1, not Redis)
- `/apps/api/src/github/handlers/push.ts` (upsert commits)
- `/apps/api/src/github/handlers/pullRequest.ts` (upsert PRs, mark merged)
- `/apps/api/src/github/handlers/installation.ts` (installation created/deleted → upsert `github_installations`)
- `/apps/web/app/admin/github/page.tsx` (admin screen: install link, list of installed repos, per-repo tracking toggle)
- `/apps/web/app/admin/github/callback/route.ts` (post-install redirect handler)

**Deliverables:**
- Admin clicks "Connect GitHub" → redirect to GitHub App install URL → on return, `installation_id` persisted, repos synced via REST.
- Webhooks received at `/v1/webhooks/github` (single static URL), HMAC-verified, `installation.id` extracted from the verified body, handlers upsert into `repos`, `github_prs`, `github_commits`. `ping` events short-circuit with 200.
- Dedup via `(installation_id, X-GitHub-Delivery)` → `ON CONFLICT DO NOTHING` in a `webhook_deliveries(delivery_id PK, received_at)` audit table (7-day retention, housekeeping in WS-13 or cron job).
- **No webhook secret rotation** for v1 (single secret in env). Dual-accept scaffolding left stubbed behind `if (false)` with a TODO linking to a future workstream.
- Tests: webhook with bad HMAC → 401, duplicate delivery → 200 dedup, `push` creates commits, `pull_request.closed` with `merged=true` marks PR merged.

**Contract out:** `github_installations.id` is referenced by `repos`. Event `commit_sha` references `github_commits.sha`.

**Acceptance:** ≥10 tests. Admin install flow works end-to-end against a test GitHub App.

---

### WS-6: Ingest binary skeleton (CLI, config, batcher, uploader)

**Purpose:** The thing developers run. CLI + config file + background loop that batches events from adapters and POSTs to the API. Adapters are stubs here; real ones in Wave 2.

**Depends on:** WS-0, WS-2 (for envelope contract).

**Files owned:**
- `/apps/ingest/src/cli.ts` (subcommands: `login`, `logout`, `status`, `run`, `uninstall`)
- `/apps/ingest/src/config.ts` (`~/.bematist/config.json` reader/writer; atomic write via tmp+rename)
- `/apps/ingest/src/auth.ts` (`login` — opens browser, device-code flow or paste-token prompt)
- `/apps/ingest/src/batcher.ts` (in-memory queue, flush every 2s or 100 events, backoff on 5xx)
- `/apps/ingest/src/uploader.ts` (`fetch` POST with bearer auth, retries with exponential backoff)
- `/apps/ingest/src/adapters/mock.ts` (fixture generator — emits synthetic events so end-to-end works before Wave 2)
- `/apps/ingest/src/daemon.ts` (main loop wiring adapters → batcher → uploader)
- `/apps/ingest/build.ts` (Bun build script — compiles per-OS binary for darwin-arm64, darwin-x64, linux-x64, win32-x64)
- `/apps/ingest/scripts/install.sh` (curl-downloadable installer — detects OS/arch, downloads binary, places in `~/.local/bin/bematist`)

**Deliverables:**
- `bematist login` opens a browser to the web app's device-code page, polls, writes `{ ingestKey, apiUrl }` to config.
- `bematist run` starts the daemon in foreground (background via `launchctl`/`systemd`/Windows service comes in WS-14).
- Mock adapter produces 5 fake events/sec; batcher flushes them to local API; API accepts; Postgres shows rows.
- Binary compiles for darwin-arm64, darwin-x64, linux-x64, win32-x64 via `bun build --compile --target=<triple>`.
- Tests: config atomic write, batcher flush timing, uploader retry on 429/5xx, bearer token included correctly.

**Contract out:** Adapters must export `{ start(emit: (e: EventEnvelope) => void): Promise<Stop> }`.

**Acceptance:** End-to-end on local machine: `bematist login` against local web → `bematist run` → mock events appear in local Postgres.

---

### WS-7: Pricing table + subscription tier detection + cost calculator

**Purpose:** Static pricing JSON + best-effort detection of which plan each dev is on.

**Depends on:** WS-0, WS-1 (for `developers` columns).

**Files owned:**
- `/packages/contracts/pricing/pricing-v1.json` (Claude Sonnet 4.6/Opus 4.7/Haiku 4.5, gpt-5/gpt-5-mini, cursor-sonnet, input/output/cache rates per Mtok, subscription totals)
- `/packages/embed/src/cost.ts` (lookup function used by `apps/api`)
- `/apps/ingest/src/tier-detect.ts` (on startup, reads `~/.claude/.credentials.json` + env vars, `~/.codex/auth.json`, Cursor user-email inference)
- `/packages/embed/src/delta.ts` (server-side monthly delta calc: `sum(cost_usd) - subscription_total`)

**Deliverables:**
- Pricing JSON covers all current models (April 2026) including cache rates.
- `cost.ts` returns `{ cost_usd, pricing_version }` for a given `(model, usage)`; unknown model → log + `pricing_version: 'unknown'` and `cost_usd: 0` (never throw, never guess).
- `tier-detect.ts` returns `{ claude: 'max_200' | 'pro_20' | 'api_key' | null, codex: 'plus' | 'pro' | 'team' | 'api_key' | null, cursor: null }` — Cursor not locally detectable, leave null.
- Dashboard override in WS-11 can upsert these values per developer.
- Tests: cost calc against fixtures for each model + cache usage; tier detect against synthetic credential files.

**Contract out:** `packages/embed` exports `computeCost(model, usage, at: Date)` and `computeMonthlyDelta(developerId, month)`.

**Acceptance:** Cost fixtures match to within $0.0001 of hand-calculated values.

---

## Wave 2 — Parallel (6 workstreams, begin after Wave 1 merged)

### WS-8: Claude Code adapter

**Purpose:** Tail `~/.claude/projects/**/*.jsonl`, emit `EventEnvelope` records. Install a `SessionStart` hook that captures `git rev-parse HEAD`.

**Depends on:** WS-6.

**Files owned:**
- `/apps/ingest/src/adapters/claude-code/index.ts`
- `/apps/ingest/src/adapters/claude-code/tailer.ts` (watches `~/.claude/projects/` with `fs.watch`, follows new JSONL lines)
- `/apps/ingest/src/adapters/claude-code/parseSessionFile.ts` (lifted from `../analytics-research`, stripped)
- `/apps/ingest/src/adapters/claude-code/installHook.ts` (writes `~/.claude/settings.json` merging a SessionStart hook that runs `bematist capture-git-sha`)
- `/apps/ingest/src/commands/captureGitSha.ts` (invoked by the hook; reads `cwd` from stdin, runs `git rev-parse HEAD`, posts to local socket)
- `/apps/ingest/src/adapters/claude-code/*.test.ts`

**Deliverables:**
- On `bematist run`, discovers existing JSONL files and tails them from current end (offset persisted in `~/.bematist/offsets.json`, atomic).
- Emits one `EventEnvelope` per JSONL line mapped by `kind`:
  - `user` record → `user_prompt`
  - `assistant` record → `assistant_response` (with usage)
  - nested `tool_use` content → `tool_call`
  - nested `tool_result` content → `tool_result`
- Dedup via `(sessionId, uuid)` — tracked per-session in a bounded LRU.
- `cwd`, `gitBranch` extracted from the envelope; `gitSha` populated by the SessionStart hook.
- Tests: parse fixture JSONL from `../analytics-research/packages/fixtures/claude-code/`, assert event count + kinds, assert `event_seq` monotonic per session.

**Contract in:** EventEnvelope Zod schema from `packages/contracts`.

**Contract out:** None beyond emit callback.

**Acceptance:** ≥12 tests. Real Claude Code session on developer's machine produces valid events within 5 seconds.

---

### WS-9: Codex CLI adapter

**Purpose:** Tail `$CODEX_HOME/sessions/**/rollout-*.jsonl`. Install hooks where supported (not Windows).

**Depends on:** WS-6.

**Files owned:**
- `/apps/ingest/src/adapters/codex/index.ts`
- `/apps/ingest/src/adapters/codex/tailer.ts`
- `/apps/ingest/src/adapters/codex/parseRollout.ts` (discriminated-union parser for `session_meta`, `turn_context`, message, tool_call, `token_count`)
- `/apps/ingest/src/adapters/codex/tokenDiff.ts` (Codex emits cumulative `token_count` — diff against running total per session)
- `/apps/ingest/src/adapters/codex/installHook.ts` (writes `~/.codex/hooks.json` — skip on Windows, log warning)
- `/apps/ingest/src/adapters/codex/*.test.ts`

**Deliverables:**
- Tails all rollout files. Parses every line into appropriate `EventEnvelope`.
- Per-turn tokens derived by diffing cumulative `token_count` events.
- SessionStart hook captures `git rev-parse HEAD` (Linux/macOS only). On Windows, best-effort from `cwd` read via `git -C` shelled from ingest daemon.
- Tests: parse fixture rollout, assert cumulative→delta token math, assert Windows branch skips hook install.

**Acceptance:** ≥10 tests. Real Codex session produces events with correct per-turn token counts.

---

### WS-10: Cursor adapter (hook-based)

**Purpose:** Write `~/.cursor/hooks.json` (with user consent on first run) pointing to the bematist binary; receive hook invocations; emit events.

**Depends on:** WS-6.

**Files owned:**
- `/apps/ingest/src/adapters/cursor/index.ts`
- `/apps/ingest/src/adapters/cursor/installHooks.ts` (merges our entries into existing `~/.cursor/hooks.json`, backs up previous as `.bak`, prompts user once via terminal if first run; choice stored in `~/.bematist/config.json`)
- `/apps/ingest/src/commands/cursorHook.ts` (the entrypoint Cursor invokes per hook event; reads JSON from stdin, posts to local daemon socket)
- `/apps/ingest/src/adapters/cursor/normalize.ts` (maps Cursor hook payloads → `EventEnvelope`)
- `/apps/ingest/src/adapters/cursor/*.test.ts`

**Deliverables:**
- On first `bematist run`, if `~/.cursor/hooks.json` does not mention us: print a one-line prompt "Install Cursor hooks? [Y/n]", wait for keypress, persist choice, proceed accordingly. `bematist cursor enable|disable` subcommand for later change.
- Handlers registered for: `beforeSubmitPrompt`, `afterAgentResponse`, `preToolUse`, `postToolUse`, `afterShellExecution`, `afterFileEdit`, `sessionStart`, `sessionEnd`.
- Each hook invocation writes to a local Unix socket (or named pipe on Windows) that the daemon listens on; daemon enqueues into batcher.
- Tests: hooks.json merge preserves existing user hooks, backup file created, normalize maps each hook shape to correct `EventEnvelope.kind`.

**Acceptance:** ≥10 tests. Real Cursor session (triggering a composer prompt) produces events in daemon within 2 seconds.

---

### WS-11: Dashboard pages

**Purpose:** The product surface managers actually use.

**Depends on:** WS-1, WS-4, WS-5, WS-7.

**Files owned:**
- `/apps/web/app/(dashboard)/layout.tsx` (nav shell, org switcher, user menu)
- `/apps/web/app/(dashboard)/page.tsx` (overview: total cost this month, API-equiv delta, sessions, merged PRs)
- `/apps/web/app/(dashboard)/developers/page.tsx` (list of developers with per-dev tiles — admin-only)
- `/apps/web/app/(dashboard)/developers/[id]/page.tsx` (per-dev: sessions table, cost breakdown, outcome list — admins see any, non-admins only see their own linked developer row)
- `/apps/web/app/(dashboard)/me/page.tsx` (personal dashboard: my sessions this week, my cost, my subscription delta, my merged outcomes, my prompt clusters — for when the signed-in user is linked to a `developer` row)
- `/apps/web/app/(dashboard)/sessions/page.tsx` (filterable session feed)
- `/apps/web/app/(dashboard)/sessions/[id]/page.tsx` (session detail: full prompt/response transcript, linked commits, cluster membership)
- `/apps/web/app/(dashboard)/prompts/page.tsx` (prompt clusters; click → sessions in that cluster; per-cluster merge rate)
- `/apps/web/app/(dashboard)/compare/page.tsx` (pick two prompts/sessions → side-by-side: tokens, cost, outcome, similar-cluster stats)
- `/apps/web/app/admin/developers/page.tsx` (override subscription tier per dev, revoke ingest keys, invite members)
- `/apps/web/app/admin/keys/page.tsx` (create/revoke ingest keys)
- `/apps/web/components/dashboard/*` (Tremor/Recharts tiles, virtualized tables via TanStack Table)
- `/apps/web/app/api/dashboard/*` (server-action or route-handler backed data fetching)

**Deliverables:**
- All pages respect RLS via `requireSession()` → `getDb(orgId)`.
- Two persona surfaces: **admin/manager** sees org-wide pages; **every signed-in user linked to a `developer` row** sees `/me` scoped to their own data. `/me` never requires admin.
- Non-admin users attempting to view another developer's `/developers/[id]` page → 403.
- Cost delta tile prominently displayed on both `/` and `/me` (the user's highlighted feature).
- Outcome column on session/dev pages shows which of the 3 attribution signals matched.
- Compare view shows tokens, cost, cluster similarity, merged-commit count for each side.
- Tests: Playwright E2E for sign-in → onboard → overview shows seeded data; non-admin user sees `/me` but is blocked from `/developers`; unit tests for data-access helpers in `packages/db`.

**Acceptance:** Dashboard renders with seed data locally. Playwright smoke suite green.

---

### WS-12: Embedding worker + prompt clustering

**Purpose:** Compute embeddings for every `user_prompt` event using MiniLM. Cluster nightly. pgvector HNSW for lookup.

**Depends on:** WS-1, WS-2.

**Files owned:**
- `/apps/worker/src/index.ts` (long-running process with cron + queue-pull loop)
- `/apps/worker/src/jobs/embedPrompts.ts` (pulls `prompts` with `embedding IS NULL`, batches 32, embeds, updates)
- `/apps/worker/src/jobs/recluster.ts` (nightly: k-means over embeddings per org, writes `prompt_clusters`, updates `prompts.cluster_id`)
- `/packages/embed/src/miniLm.ts` (lazy-load `@xenova/transformers` `all-MiniLM-L6-v2`, 384-dim)
- `/packages/embed/src/provider.ts` (interface; second provider `openai.ts` stub but not wired — future workstream enables it via per-org API key)
- `/packages/embed/src/cluster.ts` (k-means, k = sqrt(n/2) clamped to [5, 50])

**Deliverables:**
- `bun run worker` starts both jobs (embed every 30s, recluster every 24h).
- Embedding job catches up a backlog of 10k prompts in <5 min on M1.
- Clusters labeled by nearest centroid prompt text (truncated to 80 chars).
- Tests: MiniLM deterministic output on fixed input, k-means convergence on synthetic data, integration test inserts 100 prompts and asserts all get embeddings within 60s.

**Contract out:** `packages/embed` exports `embed(text: string): Promise<Float32Array>`.

**Acceptance:** ≥8 tests. 100-prompt fixture clusters visibly (3–5 clusters, sensible groupings).

---

### WS-13: Commit/PR attribution (three signals)

**Purpose:** Join `events.session_id` to `github_commits.sha` via all three methods, store results in `session_commit_links`.

**Depends on:** WS-1, WS-5, WS-8, WS-9, WS-10.

**Files owned:**
- `/apps/worker/src/jobs/attribute-cwd-time.ts` (runs every 5 min: for each new session in last hour, match `repos` by `cwd` path match + commits in time window)
- `/apps/worker/src/jobs/attribute-trailer.ts` (runs on webhook: parse `Bematist-Session:` trailer from commit messages via `git interpret-trailers --parse`, create links)
- `/apps/worker/src/jobs/attribute-scan.ts` (runs on `push` webhook: for commits without trailer match, try cwd+author window)
- `/apps/ingest/src/adapters/git/trailerHook.ts` — **no commit amending, no history rewriting**. The binary uses git's `prepare-commit-msg` hook, which runs *before the commit is finalized* and appends the trailer into the in-flight commit message. Mechanism:
  - `bematist git enable` sets a global `git config --global core.hooksPath ~/.bematist/git-hooks` (backs up existing value to `~/.bematist/config.json` so `bematist git disable` restores it).
  - Writes `~/.bematist/git-hooks/prepare-commit-msg` (executable shell) that:
    1. Reads the in-flight commit message file (arg `$1`).
    2. Reads current session id from `~/.bematist/current-session` (written by the daemon whenever a session is active; missing → exit 0 cleanly).
    3. Appends the trailer using `git interpret-trailers --trailer "Bematist-Session: <id>" --in-place "$1"` (idempotent — git's own trailer machinery handles dedup).
    4. Exits 0 always; never blocks a commit.
  - No per-repo `.git/hooks/` modification → no clash with Husky/pre-commit frameworks.
  - Opt-in via `bematist git enable` (default off). `bematist git status` reports whether the global hook path is ours.
- `/apps/worker/src/*.test.ts`

**Deliverables:**
- All three jobs write to `session_commit_links` with distinct `signal` values; a session/commit pair can have multiple rows.
- Dashboard (WS-11) reads and shows which signals agreed.
- Trailer hook: opt-in per developer via `bematist git enable` (default off). The hook uses `prepare-commit-msg` so no commits are amended and no git history is rewritten; the trailer is added as the commit is being composed.
- Tests: fixture sessions + commits assert all three signals produce expected links or correctly skip.

**Contract out:** None downstream.

**Acceptance:** ≥10 tests. With a seeded session + matching commit, `cwd_time` + `trailer` + `scan` all link it.

---

## Wave 3 — Ship (serial)

### WS-14: Railway deployment pipeline + binary distribution

**Purpose:** Everything runs in production. Developers can actually download the binary.

**Depends on:** all prior workstreams merged.

**Files owned:**
- `/infra/railway.json` (Railway service definitions: web, api, worker, postgres)
- `/infra/Dockerfile.web`, `/infra/Dockerfile.api`, `/infra/Dockerfile.worker` (multi-stage bun builds)
- `/.github/workflows/ci.yml` (lint, typecheck, test on every push)
- `/.github/workflows/release.yml` (on tag: build 4 binaries, upload to GitHub Release, publish versioned `install.sh`)
- `/apps/web/app/install.sh/route.ts` (serves `install.sh` that curl-pipes to user; reachable via `https://<railway-subdomain>/install.sh`)
- `/apps/ingest/scripts/install.sh` (the actual installer served above — detects OS/arch, downloads signed binary from GitHub Release, verifies SHA256, places in `~/.local/bin/bematist`)
- `/infra/service-install/launchd.plist.tmpl` + `systemd.service.tmpl` + `windows-service-install.ps1` (optional `bematist install-service` subcommand for autostart)

**Deliverables:**
- `git push` to main → CI runs → merge protected by green CI.
- `git tag v0.x.y && git push --tags` → release workflow builds binaries → publishes.
- Railway deploys web + api + worker on `main` push.
- Install command works on macOS arm64, macOS x64, Linux x64, Windows (via Git Bash or pwsh equivalent).
- **Domain for v1**: use Railway's auto-generated subdomain (e.g. `bematist.up.railway.app`). `bematist.dev` is occupied by the user's existing analytics-research project and is out of scope to re-point. Custom domain is a future workstream once dogfood validates MVP.
- Tests: none runtime; dry-run of `install.sh` on CI matrix.

**Acceptance:** Deployed. One team member on each OS can install and run the binary and see themselves in the dashboard.

---

### WS-20: Onboarding UX — single-command setup

**Purpose:** Collapse current 9-step onboarding to 3 commands. New dev receives an ingest key and a one-liner from admin, runs:

```bash
curl -fsSL https://<app>/install.sh | sh
bm-pilot login <token>
bm-pilot start
```

After `start`, the daemon runs in the background, auto-detects installed AI-coding tools (Claude Code / Codex / Cursor), installs their hooks, enables the git-trailer hook, disables the mock adapter, and survives terminal close + computer restart via the OS service manager (launchd / systemd / Task Scheduler). No config editing, no hook JSON hand-editing.

**Depends on:** WS-8 (claude-code adapter + its `installHook`), WS-9 (codex adapter + its `installHook`), WS-10 (cursor adapter + existing `bm-pilot cursor enable`), WS-13 (git trailer hook + existing `bm-pilot git enable`), WS-14 (service-install templates), WS-17 (bm-pilot naming), WS-19 (login token format).

**Files owned:**
- `apps/ingest/src/cli.ts` — add `start`, `stop`, `restart` subcommands; extend `status` output; change `login` to accept a positional token arg; wrap current `run` as `run --foreground`-equivalent (kept for debugging).
- `apps/ingest/src/commands/onboard.ts` (new) — orchestration layer that: detects available AI tools; toggles adapters in config; invokes existing `installHook` routines from each adapter package; installs the git trailer hook; disables mock; writes back config atomically.
- `apps/ingest/src/commands/service.ts` (new) — cross-platform service manager abstraction: `installService()`, `startService()`, `stopService()`, `uninstallService()`, `serviceStatus()`. Dispatches to one of:
  - `apps/ingest/src/commands/service/launchd.ts` — macOS; uses `launchctl bootstrap gui/$UID <plist>` + `launchctl kickstart` + `launchctl bootout`; writes plist to `~/Library/LaunchAgents/com.bm-pilot.agent.plist` from `infra/service-install/launchd.plist.tmpl`.
  - `apps/ingest/src/commands/service/systemd.ts` — Linux; uses `systemctl --user enable --now bm-pilot.service` + `systemctl --user disable --now`; writes unit to `~/.config/systemd/user/bm-pilot.service` from `infra/service-install/systemd.service.tmpl`.
  - `apps/ingest/src/commands/service/windows.ts` — Windows; uses PowerShell `Register-ScheduledTask` / `Unregister-ScheduledTask` via `schtasks.exe` CLI; wraps the logic in `infra/service-install/windows-service-install.ps1`.
- `apps/ingest/src/commands/detect.ts` (new) — synchronous filesystem checks: `hasClaudeCode()` (`~/.claude/` exists), `hasCodex()` (`~/.codex/` or `$CODEX_HOME`), `hasCursor()` (platform-specific Cursor config path). Return a `DetectionResult` struct consumed by `onboard.ts`.
- `apps/ingest/src/commands/doctor.ts` (new) — diagnostic report: config validity, token format, api reachability (`GET /healthz`), adapter detection + hook install states, daemon running, service installed. Non-zero exit on any failing critical check. Prints remediation hints inline.
- `apps/ingest/src/auth.ts` — extend `promptLogin` to accept a provided token, skipping the interactive prompt when present.
- `apps/ingest/src/config.ts` — tighten `freshConfig()` to ship `adapters: {}` (empty) instead of `{ mock: { enabled: true } }`. Mock adapter becomes opt-in.
- `apps/ingest/src/adapters/claude-code/installHook.ts` + `apps/ingest/src/adapters/codex/installHook.ts` — already have `installHook({...})` / `uninstallHook(...)` helpers; do NOT rewrite, just call them from `onboard.ts`.
- `apps/ingest/scripts/install.sh` — add a concluding line that suggests running `bm-pilot login <token>` then `bm-pilot start` (currently only suggests `bm-pilot login`).
- `apps/web/app/(marketing)/install/page.tsx` + `apps/web/components/dashboard/EmptyState.tsx` — update the copy to show the 3-line onboarding (currently shows an older flow).

**Do NOT touch:**
- Adapter internals (tailers, parsers, normalize) — all solid; WS-20 is pure CLI / orchestration.
- Admin dashboard server actions, schema, webhook receiver, API auth — out of scope.
- Existing `bm-pilot cursor enable` / `bm-pilot git enable` / `bm-pilot capture-git-sha` / `bm-pilot cursor-hook` subcommands — keep as-is (used internally by `onboard.ts` and by hook installers).
- `plan.md` — orchestrator updates status on merge.

**Deliverables:**

1. **CLI surface changes:**
   - `bm-pilot login [token]` — positional `token` arg; still prompts when absent. Validate existing regex.
   - `bm-pilot start` — (a) runs `onboard.ts` end-to-end: detects tools, toggles adapters, installs all hooks (Claude Code SessionStart, Codex hooks, Cursor hooks, git trailer), disables mock. (b) Installs the OS service + starts it via `service.ts`. Idempotent: running twice is a no-op for already-installed parts. Prints per-step status with ✓/✗ markers only if the user explicitly opts into emojis via a flag; default is plain ASCII (`[ok]` / `[skip]` / `[fail]`).
   - `bm-pilot stop` — stops service; does NOT uninstall service by default. Pass `--uninstall` to also remove the launchd/systemd/scheduled-task entry.
   - `bm-pilot restart` — `stop` then `start` (skips onboarding re-run; just bounces the service).
   - `bm-pilot status` — extend current JSON output: add `daemonRunning`, `servicePid`, `serviceUptimeSec`, `serviceInstalled`, `hookStates: { claudeCode, codex, cursor, gitTrailer }`, `detectedTools`. Keep existing fields.
   - `bm-pilot doctor` — diagnostic output; always prints human-readable table; `--json` flag for machine output.
   - `bm-pilot run` — stays foreground (used by the service unit and by local debugging). No behavior change.

2. **Fresh-install defaults:**
   - `freshConfig()` ships `adapters: {}`. The seeded install.sh config matches.
   - On first `bm-pilot start`, adapters are populated by auto-detection.
   - On upgrade (existing config has `adapters.mock.enabled: true`), `bm-pilot start` disables mock and populates real adapters. Writes `.bak` snapshot of the pre-migration config at `~/.bm-pilot/config.json.bak-pre-ws20`.

3. **Autostart behavior:**
   - `bm-pilot start` installs + launches the service in one shot.
   - Service runs `bm-pilot run` (the existing foreground command).
   - Service survives logout + reboot.
   - Logs routed to `~/.bm-pilot/daemon.log` (stdout + stderr appended). Log rotation = out of scope (daemon will trim if file >10MB, truncating the first half — minimal built-in protection).

4. **Error paths:**
   - Missing ingest key → `bm-pilot start` refuses with clear message pointing at `bm-pilot login`.
   - Token invalid → fails before starting service; explains format.
   - Service install fails (no launchd/systemd/no Task Scheduler) → falls back to spawning a detached background process writing PID to `~/.bm-pilot/daemon.pid`. `bm-pilot stop` reads PID, SIGTERM, waits 5s, SIGKILL.
   - Hook install fails for any one tool → log warning, continue with others. `doctor` will flag it for manual attention.
   - Already-installed detection: each subsystem is idempotent. Running `bm-pilot start` twice is safe.

**Tests:**
- Unit tests for `detect.ts` with temp home dirs; present / absent matrices.
- Unit tests for `onboard.ts` that mock the hook installers; verify correct call sequence, mock disable, adapter enable, config bak.
- Unit tests for `service.ts` dispatch logic with an injectable `platform` arg (macOS/linux/win32) + injected `exec` fn; verify correct commands issued. Real service install is NOT tested in CI; documented in a manual test matrix at `apps/ingest/docs/onboard-manual-tests.md` (new file — the ONLY docs file WS-20 creates).
- `doctor.ts`: unit tests covering each check; mock `fetch` for the api reachability probe.
- `login` positional token: add test to existing `apps/ingest/src/auth.test.ts`.
- Full suite must stay green. Baseline at start of WS-20: 415 pass / 0 fail (+ one known tailer flake). Expected after: ~430-450 pass / 0 fail.

**Acceptance:**
- `curl … /install.sh | sh && bm-pilot login <token> && bm-pilot start` on a fresh macOS arm64 machine: daemon is running, survives `killall Terminal` + logout/login, adapters for detected tools are active, hooks are installed, mock is disabled.
- Same sequence on Linux x64 (Ubuntu 22.04+): systemd user unit installed, `systemctl --user status bm-pilot` green, daemon running.
- Same sequence on Windows x64 (Git Bash + PowerShell): scheduled task registered, daemon running, survives logout/login.
- `bm-pilot status` reports all of the above accurately.
- `bm-pilot stop --uninstall` removes the service cleanly; re-running `bm-pilot start` reinstalls cleanly.
- `bm-pilot doctor` on a healthy install → exit 0, all ✓. On a broken install (e.g. rm -rf'd hooks) → exit 1, specific actionable output.

**Non-goals (explicit):**
- No dashboard invite UI. Teammates can view their own `/me` only by admin pre-generating an invite token via `signInvite()` — separate workstream.
- No log rotation beyond the built-in 10MB truncation — revisit if dogfood logs blow up.
- No `bm-pilot upgrade` command. Users rerun the `curl | sh` to upgrade. In-place binary self-update is a future workstream.
- No auth-less enrollment / device-code flow — still paste-token v1.
- No per-adapter opt-out flags on `start`. If a tool is detected and fails, we warn and continue; manual override lives in `~/.bm-pilot/config.json`.
- No "bm-pilot init" wizard with prompts. `start` is non-interactive by design.

---

### WS-15: Internal dogfood

**Purpose:** All 5 team members install, run, and verify. Collect friction notes. No code work unless bugs appear.

**Depends on:** WS-14.

**Files owned:** `/docs/dogfood-notes.md` (one file created here — otherwise no code).

**Deliverables:**
- Each developer has telemetry flowing for 72 continuous hours.
- Manager dashboard shows all 5 developers' data.
- At least one merged PR is correctly attributed via each of the three attribution signals.
- Friction log of ≥5 specific issues discovered.

**Acceptance:** Sign-off from team.

---

### WS-21: Historical session backfill

**Purpose:** Capture Claude Code and Codex CLI sessions that happened *before* `bm-pilot start`. The tailers in WS-8/WS-9 start from EOF on first discovery, so a fresh install today sees no history — a user with months of local JSONL files has nothing in the dashboard until they start a new session. This workstream adds a `bm-pilot backfill` subcommand that reads existing session files from byte 0, emits envelopes through the same parse/upload path as the live tailers, and bumps offsets to EOF so the live tailer picks up cleanly on next start. Cursor is skipped (hook-driven, no persistent log to backfill from).

**Depends on:** WS-6 (CLI harness), WS-8 (claude-code parser), WS-9 (codex parser + tokenDiff + offsets-codex lock), WS-17 (`~/.bm-pilot/` state dir), WS-20 (daemon PID file + `serviceStatus()` so backfill can detect a running daemon).

**Files owned:**
- `apps/ingest/src/commands/backfill.ts` (new) — orchestration: parse flags, check daemon state, enumerate files per adapter, call adapter-specific backfill readers, drain uploader, update offsets, print summary.
- `apps/ingest/src/commands/backfill.test.ts` (new) — end-to-end with fixture JSONL trees in a temp home; mock uploader; verify envelope count, dedup safety, offset bumping, dry-run flag.
- `apps/ingest/src/adapters/claude-code/backfillReader.ts` (new) — `enumerateHistoricalFiles({ root, sinceMs }) → FileInfo[]` + `readFileToEnvelopes(path, ctx) → AsyncIterable<EventEnvelope>`. Reuses `parseLineToEnvelopes` + `makeSessionStartEnvelope` + `makeSessionEndEnvelope` from `parseSessionFile.ts`. No change to `parseSessionFile.ts` itself.
- `apps/ingest/src/adapters/claude-code/backfillReader.test.ts` (new).
- `apps/ingest/src/adapters/codex/backfillReader.ts` (new) — same shape. Reuses `parseRolloutLine` and carries the per-session `tokenDiff` state for the duration of one file.
- `apps/ingest/src/adapters/codex/backfillReader.test.ts` (new).
- `apps/ingest/src/cli.ts` — add `backfill` subcommand, extend help text. No other changes.

**Do NOT touch:**
- Live tailers (`tailer.ts` in either adapter). Backfill is a parallel reader that acquires the existing codex offsets lock (and relies on atomic tmp+rename for claude-code) but does NOT modify tailer code paths.
- `parseSessionFile.ts` / `parseRollout.ts` / `tokenDiff.ts` — reuse as-is.
- Uploader / Batcher / auth / normalize — reuse as-is.
- Daemon / service commands / onboard.ts — WS-20 territory, stable.
- DB schema, server routes, dashboard — out of scope.
- `plan.md` — orchestrator updates status on merge.

**Deliverables:**

1. **CLI surface:** `bm-pilot backfill [--since <duration>] [--dry-run] [--force] [--adapter claude-code|codex]`
   - `--since` default `30d`. Accepts `7d`, `72h`, `all`. Filter is by file mtime (a session file last modified before the cutoff is skipped; otherwise read from byte 0).
   - `--dry-run` scans and reports what *would* be uploaded (file count, approximate event count per adapter) without emitting.
   - `--force` proceeds even when the daemon / service appears to be running (default behavior refuses with a clear message: "stop the service first or pass `--force`"). Server-side dedup on `(org_id, session_id, event_seq, client_event_id)` protects against races.
   - `--adapter` restricts to one adapter. Omit to run both claude-code and codex.

2. **Per-adapter backfill readers** expose:
   - `enumerateHistoricalFiles({ root, sinceMs })` returning `{ path, mtimeMs, sizeBytes }[]`.
   - `readFileToEnvelopes(path, ctx)` returning an async iterable of `EventEnvelope` — streaming, not all-at-once, so large session files don't blow memory.
   - Emits `session_start` + all line-derived envelopes + `session_end` synthetic in that order, per file, using the existing helpers.

3. **Offset handling after successful upload:**
   - For each file fully processed without upload failure, set the offsets entry for that absolute path to its current `statSync(path).size` in the adapter's offsets file. Uses the existing on-disk shape (claude-code: `{version:1, files:{...}}`; codex: `{codex:{...}}` under the codex lock).
   - On partial failure (uploader exhausted retries on some batch), leave that file's offset untouched and exit nonzero with a clear error; no partial bumping.

4. **Summary output:**
   - Human default:
     ```
     backfill complete
       claude-code: 42 files  ·  3,218 envelopes  ·  1.2 MB uploaded
       codex:       11 files  ·    417 envelopes  ·  180 KB uploaded
       cursor:      skipped (no historical record)
     offsets advanced to EOF for all processed files.
     ```
   - `--json` flag optional; if included, emit a machine-readable summary instead.

5. **Safety:**
   - Refuses to run without a valid ingest key in config (same check as `bm-pilot start`).
   - Refuses when daemon PID file or service reports running, unless `--force`.
   - Acquires the codex offsets lock (`~/.bm-pilot/offsets-codex.lock`) for the duration of codex backfill; releases on exit including error path.
   - Atomic tmp+rename on offsets files (already standard).

**Tests:**
- `backfillReader.test.ts` (both adapters): fixture directory trees with 2–3 session files, verify file enumeration respects `sinceMs`, verify envelope iteration matches expected count, verify tokenDiff state is reset between files for codex.
- `backfill.test.ts`: fixture home, mock uploader, run backfill end-to-end, assert envelope emission order (session_start before line envelopes before session_end), assert offsets advanced, assert dry-run emits nothing, assert `--force` bypasses the daemon-running check, assert missing ingest key → refuse.
- Baseline at start of WS-21: 460 pass / 0 fail. Expected after: ~485–500 pass / 0 fail.

**Acceptance:**
- On a machine with existing `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/rollout-*.jsonl`, running `bm-pilot backfill` after `bm-pilot login` (and with the service stopped) uploads historical events to the configured API. Dashboard shows sessions with start timestamps predating the install.
- Running `bm-pilot backfill` twice in a row is idempotent (server-side dedup; second run is a no-op in terms of inserted rows, though it still iterates files).
- Running `bm-pilot start` after a backfill does not re-emit backfilled events (offsets at EOF).

**Non-goals (explicit):**
- No git-sha reconstruction for historical events. `git_sha` stays null for backfilled events (the capture-git-sha queue is populated only by live hooks).
- No Cursor backfill (hook-driven; no persistent event log on disk).
- No dashboard UI changes. Historical sessions show up in the existing sessions list.
- No cross-machine backfill (a user can only backfill files on the machine where they run the command).
- No interactive prompts. `backfill` is non-interactive like `start`.
- No per-file resumption after a mid-run failure — if a batch upload fails and retries are exhausted, the user re-runs `backfill`; server dedup handles overlap.

---

# Milestones

| Milestone | Criteria | Who signs off |
|---|---|---|
| **M0 — Repo alive** | WS-0 merged | Orchestrator |
| **M1 — Skeletons all green** | Wave 1 (WS-1..WS-7) all merged, integration test: mock adapter → API → Postgres works end-to-end | Orchestrator |
| **M2 — Real telemetry flowing** | Wave 2 (WS-8..WS-13) all merged, real Claude Code + Codex + Cursor sessions produce events in Postgres | Orchestrator + one human spot-check |
| **M3 — Deployed** | WS-14 merged, Railway live, curl install works on each OS | Orchestrator + human smoke-test |
| **M4 — Dogfood** | WS-15 complete, 5 devs × 72h uptime | Human (user) |

No fixed dates. We advance a milestone only when the preceding one is fully green.

---

# Status tracking

Each workstream gets a status line kept up to date by the orchestrator:

- `todo` — not yet assigned
- `in-progress — <worktree-path> — <agent-id>` — currently running
- `review` — subagent returned, awaiting orchestrator review
- `merged` — merged into main

**Current status:**

- WS-0: merged (2026-04-19, commit `3f4165b`). Monorepo scaffolding + docker-compose + shadcn `<Button>`.
- WS-1: merged (2026-04-19, commit `2889f7a`). Drizzle schema for 14 + 1 tables (adds `webhook_deliveries`), RLS via `app_current_org()` on 12 org-scoped tables, monthly partitions for events/prompts via `ensure_partitions(3)`, pgvector HNSW on `prompts.embedding`, pricing seeded from JSON. Creates role `app_bematist` (NOBYPASSRLS, password `app_bematist_dev`). 18 tests green. Exports from `@bematist/db`: all schema tables, `getDb`, `getAdminDb`, `runMigrations`, `loadPricingSeed`. `@bematist/db/testing` exports `createMigratedDatabase` for test harnesses. Production `DATABASE_URL` must use `app_bematist`, not the superuser.
- WS-2: merged (2026-04-19, commit `884e86d`). POST `/v1/events` with bearer `bm_<orgId>_<keyId>_<secret>`, batch cap 1000. `EventEnvelope` Zod schema in `@bematist/contracts` (strict, discriminated union on `kind`, `payload.kind === envelope.kind` refine). `insertEvents` upserts sessions per `(source, source_session_id)` then inserts events referencing `sessions.id`. Cost pinned on insert. 40 WS-2 tests green (57 total including WS-1's). 10k batch insert ~270ms.
- WS-3: merged (2026-04-19, commit `641d859`). Landing `/` + `/install`, Motion animations, Tailwind v4 `@theme` + dark mode. Brand tokens in `@bematist/ui/brand`. Install CTA points at placeholder `bematist.up.railway.app` — WS-14 replaces. Playwright e2e uses `.e2e.ts` suffix to dodge `bun test`'s default glob.
- WS-4: merged (2026-04-20, commit `f580e45`, merge `073c866`). Better-Auth + GitHub OAuth (scopes `read:user`, `public_repo`), Drizzle adapter, `nextCookies` plugin. `requireSession()` + `getOptionalSession()` in `apps/web/lib/session.ts`. Bridge resolver in `packages/auth/src/bridge.ts` returns `already_bridged | claimed_existing_invite | needs_bootstrap` (stateless — caller routes to `/post-auth/new-org` on `needs_bootstrap`). Invites are **stateless HMAC-signed tokens** (no `invites` table): `packages/auth/src/invite.ts` exports `signInvite(secret, { orgId, email, role, exp })` + `verifyInvite`; layout `base64url(payload).base64url(hmac)`, default TTL 7 days, signed with `BETTER_AUTH_SECRET`. Better-Auth tables live in `packages/auth/migrations/0001_better_auth.sql` (not `packages/db/`) and ship their own runner `applyAuthMigrations({ url })` at `@bematist/auth/migrations` subpath — deploy must run WS-1 migrations + this. Auth tables not RLS-scoped; grants conditional on `app_bematist` role. `apps/web/lib/session.ts` duplicates ~25 lines of DB client code (inlines `adminConnection` + `withOrgScope`) because Next.js Turbopack can't statically resolve `new URL(..., import.meta.url)` in `packages/db/src/migrate.ts` — **follow-up**: split `packages/db` entrypoint so migrate is subpath-only, then delete the duplication. Introduces `ADMIN_DATABASE_URL` env (falls back to `DATABASE_URL`) for the single cross-tenant `better_auth_user_id → (user, org)` lookup. 13 new tests (5 bridge, 5 invite, 3 integration against `createMigratedDatabase` + `applyAuthMigrations` exercising real RLS via `app_bematist` role). Playwright smoke deferred to WS-11.
- WS-5: merged (2026-04-20, commit `3bc12cd`). GitHub App install + webhook receiver. `POST /v1/webhooks/github/:installation_id` extends WS-2's `Bun.serve` router. HMAC verify via `verifyGithubSignature` (single secret v1; dual-accept rotation scaffolded behind `if (false as boolean)` for future workstream). Dedup on `webhook_deliveries(delivery_id PK)` returns `{ ok: true, deduped: true }`. Handlers: `push.ts` (commit upsert with PR linking by head_sha; `ON CONFLICT (repo_id, sha) DO UPDATE` preserves existing fields via COALESCE), `pullRequest.ts` (state + merged_at on `closed+merged`), `installation.ts` (created/deleted soft-delete; `installation_repositories` nested in same file). Installation token cache in-memory with TTL = expires_at − 60s; JWT minted RS256 from `GITHUB_APP_PRIVATE_KEY` (accepts raw PEM or base64). RLS pattern: webhook receiver uses `adminSql` ONLY for the two unavoidable cross-tenant lookups (resolve installation_id → org_id; webhook_deliveries dedup which has no `org_id`); all handlers receive tenant-scoped `sql` and open transactions setting `app.current_org_id` before writes. New env: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (raw PEM or base64), `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET`. Admin pages at `/admin/github` + `/admin/github/callback` gate on `session.role === 'admin'`; callback refuses cross-org installation re-claim. `ServerDeps.adminSql` added to `apps/api/src/index.ts` — reads `ADMIN_DATABASE_URL`, falls back to `DATABASE_URL`. 27 new tests (verify HMAC paths, install token cache + mint, full webhook route incl. dedup + bad sig + each event handler + cross-tenant probe). Playwright deferred to WS-11.
- WS-6: merged (2026-04-20, commit `dcb65ea`, merge `4810d34`). CLI subcommands `login|logout|status|run|uninstall|version|help`; paste-token v1 login (device-code deferred); `~/.bematist/config.json` atomic tmp+rename, 0o600; uploader with DI'd `fetch`/`sleep`, exp backoff + `Retry-After`, `UploadAuthError`/`UploadPermanentError`/`UploadRetriesExhaustedError`; batcher (size=100, time=2000ms, drains on stop, drops 4xx, retains 5xx-exhausted); mock adapter ~5 events/sec; 4-target compile via `apps/ingest/build.ts` (scripts: `build:binary` + per-target); POSIX `install.sh` with `BEMATIST_BINARY_BASE_URL` placeholder (WS-14 replaces). 39 ingest tests. Frozen adapter contract in `apps/ingest/src/adapters/types.ts`: `Adapter { name; start(emit): Stop }`, `EmitFn = (EventEnvelope) => void`, `Stop = () => Promise<void>`, `AdapterContext { deviceId, clientVersion }`.
- WS-7: merged (2026-04-20, commit `c86f9b2`). Canonical pricing at `packages/contracts/pricing/pricing-v1.json` (object form: `pricing_version`, `models[]`, `subscriptions{}`); `packages/db/seed/pricing.json` kept as-is (array form) with a drift-detection test in `packages/embed/src/cost.test.ts` (follow-up workstream should refactor `packages/db/src/seed.ts` to re-read canonical). `@bematist/embed` exports: `computeCost(model, usage, at) → { cost_usd, pricing_version }` (unknown model → `cost_usd: 0, pricing_version: 'unknown'`, never throws, warns once per unknown model); `computeMonthlyDelta(db: OrgScopedDb, developerId, month) → { actualUsd, subscriptionUsd, deltaUsd }`; `findPricing`, `listPricingRows`, `listSubscriptions`, `getSubscriptionMonthlyUsd`, `computeCostFromRow`. `apps/ingest/src/tier-detect.ts` exports `detectTiers({ homeDir?, env? })` — reads `~/.claude/.credentials.json`, `ANTHROPIC_API_KEY`, `~/.codex/auth.json`, `OPENAI_API_KEY`; Cursor always null. gpt-5/gpt-5-mini kept WS-1 seed values (1.25/10/0.125 and 0.25/2/0.025) over spec starters — consistency with WS-2's insert path. 35 new tests.
- WS-8: merged (2026-04-20, commit `4253e1e`, merge `fd66f56`). Claude Code adapter. `createClaudeCodeAdapter(ctx, opts?)` implements the frozen `Adapter` contract. Tailer watches `~/.claude/projects/` via `fs.watch({recursive:true})` + 500ms `setInterval` poll fallback (Linux kernel recursive-watch caveats). Tails from EOF on first discovery; growth only thereafter. Offsets persisted atomically at `<stateDir>/offsets-claude-code.json` (per-adapter — see `b7fabc2`) in shape `{ version: 1, files: { <abs-path>: <number> } }`. Dedup via `(sessionId, uuid)` bounded LRU ~10k. Emits: `user` → `user_prompt`; `assistant` → `assistant_response` with usage; nested `tool_use`/`tool_result` → `tool_call`/`tool_result` (note: `tool_result` records don't carry `tool_name`, only `tool_use_id`; dashboard must join by id to get name). `session_start` emitted on file discovery; `session_end` synthetic on inode change or truncation. SessionStart hook at `~/.claude/settings.json` invokes `bematist capture-git-sha`; hook handler reads stdin JSON, runs `git -C <cwd> rev-parse HEAD`, writes `<stateDir>/git-sha-queue/<session_id>.json`; tailer polls this dir per tick and attaches sha to matching session's envelopes. `installHook` preserves existing hooks, creates `.bak` on first change, idempotent. 34 new tests.
- WS-9: merged (2026-04-20, commit `4b48a7b`, merge `d634bdc`). Codex CLI adapter. `createCodexAdapter(ctx, options)` tails `$CODEX_HOME/sessions/**/rollout-*.jsonl` (defaults to `~/.codex/sessions`). Handles three rollout shapes (wrapped `event_msg`, bare `type`, real-CLI `type:"event_msg"` wrapper); skips `info:null` rate-limit pings. `tokenDiff.ts` turns cumulative `token_count` records into per-turn deltas, ignores non-monotonic decreases. Per-adapter offsets at `~/.bematist/offsets-codex.json` in shape `{ codex: { <abs-path>: <number> } }` with file lock at `~/.bematist/offsets-codex.lock` (atomic read-modify-write; 5–20ms jittered retries, 500ms deadline, stale-lock recovery at 10s mtime). Installation hook at `~/.codex/hooks.json` (Linux/macOS); Windows fallback: tailer shells out to `git rev-parse HEAD` via `Bun.spawn` (DI'd `runGit` for tests) when it sees `session_meta` with a resolvable `cwd`. Hook command: `bematist capture-git-sha --queue <queueDir>` (WS-8's handler ignores argv — uses its default; paths align). 29 new tests.
- WS-10: merged (2026-04-20, commit `6e53977`, merge `94abe2a`). Cursor adapter (hook-based). **Required orchestrator fix `f6433dd`**: `AdapterConfigSchema` `.strict()` → `.passthrough()` so `adapters.cursor.promptedAt` (ISO8601) persists through `writeConfig`. Outer `ConfigSchema` stays strict. Socket IPC server: Unix socket at `~/.bematist/cursor.sock` on macOS/Linux, named pipe `\\?\pipe\bematist-cursor` on Windows. Protocol: JSON-per-line; acks `{ok:true}` or `{ok:false,error}`. 8 Cursor hooks mapped via `normalize.ts` → `EventEnvelope` (`beforeSubmitPrompt`, `afterAgentResponse`, `preToolUse`, `postToolUse`, `afterShellExecution`, `afterFileEdit`, `sessionStart`, `sessionEnd`); stable UUID via uuidv5(source_session_id). `installHooks.ts` merges bematist entries into `~/.cursor/hooks.json`, preserves user hooks, `.bak` on first change only, idempotent; exports `uninstallHooks`. `cursorHook.ts` entrypoint: reads stdin, posts to socket with 250ms timeout, always exits 0, appends failures to `~/.bematist/cursor-hook-errors.log`. Exports `ensureCursorConsent({binaryPath, prompts})` (terminal Y/N prompt) and `disableCursor()`. 36 new tests.
- WS-11: merged (2026-04-20, commit `628d47c`, merge `53fcb65`). Dashboard pages. Routes: `/overview` (NOT `/` — marketing owns `/` per WS-3; Next.js 16 refuses dual page.tsx resolving to same URL), `/me`, `/sessions`, `/sessions/[id]`, `/developers`, `/developers/[id]`, `/prompts`, `/compare`, `/admin/developers`, `/admin/keys`, `/api/dashboard/overview`. All gate on `requireSession()`; admin pages additionally gate on `session.role === 'admin'`. Cost delta tile uses `computeMonthlyDelta` via `apps/web/components/dashboard/orgDb.ts` — **third Turbopack-workaround duplication** of `withOrgScope` (after WS-4's `lib/session.ts` and WS-5's callback route). Data access in `apps/web/components/dashboard/queries.ts` (overview aggregates, developers, sessions, transcript join with `events`+`prompts`, attribution signals from `session_commit_links`, cluster summary, ingest keys, compare shape). Widgets: `StatTile`, `CostDeltaTile`, `SessionRow`, `SessionFilterBar`, `DeveloperCard`, `Transcript`, `DashNav`, `EmptyState`. Admin developers page links out to WS-4's programmatic `signInvite` flow (no invite UI; follow-up workstream for revocable invites table). Compare "cluster similarity" reads `prompts.cluster_id` (same-cluster y/n) — populated by WS-12 post-merge. 42 new tests (16 format + 18 queries integration + 8 authz + Playwright redirects smoke). Full signed-in Playwright deferred (documented manual steps in e2e file).
- WS-12: merged (2026-04-20, commit `160f319`, merge `bd99370`). Embedding worker + prompt clustering. `packages/embed` additively exports: `embed(text)`, `embedBatch(texts)`, `MINI_LM_DIM=384`, `MINI_LM_MODEL_ID`, `MiniLmProvider`, `EmbeddingProvider` type, `chooseK`, `clusterEmbeddings`, `cosineSimilarity`, `ClusterOptions`, `ClusterResult`. MiniLM via `@xenova/transformers` `Xenova/all-MiniLM-L6-v2` (384-dim, quantized); lazy `import()` on first call; `env.allowLocalModels = false`. k-means++ deterministic (Mulberry32 PRNG), `k = clamp(floor(sqrt(n/2)), 5, 50)`, 20-iter cap, empty-cluster re-seeding from farthest point. Worker: `apps/worker/src/{index,jobs/embedPrompts,jobs/recluster}.ts`. `runEmbedOnce({sql, provider, batchSize=32, maxPerTick=300})` pulls `prompts WHERE embedding IS NULL`, per-batch transaction with org `set_config`. `runReclusterOnce({sql, seed})` iterates distinct `org_id`, k-means per org, writes `prompt_clusters` (label = nearest-to-centroid prompt text, 80-char truncation with `…`), updates `prompts.cluster_id`. Idempotent. `startWorker()` wires SIGTERM/SIGINT to drain + exit 0. Intervals: `WORKER_EMBED_INTERVAL_MS` (default 30s), `WORKER_RECLUSTER_INTERVAL_MS` (default 24h) — interval-ms instead of spec's cron for test-friendliness. Notable pitfall: `postgres-js` truncates `timestamptz` bound params to JS ms precision; worked around by selecting `created_at::text` and comparing text. Model cache via `BEMATIST_MODEL_CACHE_DIR`. 24 new tests; full suite 337.
- WS-13: merged (2026-04-20, commit `ef03bf9`). All three attribution signals + git trailer hook. Worker schedules `attribute-cwd-time` every 5 min (env override `WORKER_CWD_TIME_INTERVAL_MS`); matches session.cwd path-segment against `repos.name` short-name (derived from `remote.origin.url`), pulls commits in `[started_at − 10m, ended_at + 10m]`, inserts `signal='cwd_time'` `confidence=0.6`. `attribute-trailer` parses `Bematist-Session: <uuid>` trailers — server-side parser walks back from last non-empty line collecting contiguous trailer block (matches git's semantics; ignores body-level trailer-shaped lines), strict UUIDv1-5 regex, dedups within message; `signal='trailer'` `confidence=1.0`. `attribute-scan` skips commits with valid trailer (trailer path owns those), falls back to `developers.email = commit.authorEmail` within `committed_at ± 10m`; `signal='webhook_scan'` `confidence=0.4`. Webhook integration: `apps/api/src/github/webhook.ts` calls `runPushAttribution` (in `apps/api/src/github/handlers/pushAttribution.ts`) inline after `handlePush` under same tenant-scoped sql so all writes respect RLS. New cross-package dep: `apps/api` → `@bematist/worker` (job code reused by webhook receiver). Trailer hook: `bematist git enable|disable|status` in `apps/ingest/src/adapters/git/trailerHook.ts` — sets global `core.hooksPath ~/.bematist/git-hooks`, backs up prior value into config under `gitHooksPathBackup`, generates `prepare-commit-msg` shell that runs `git interpret-trailers --if-exists addIfDifferent --in-place "$1"` reading session id from `~/.bematist/current-session`. **No commit amending. No history rewriting.** Daemon (`apps/ingest/src/daemon.ts`) writes `~/.bematist/current-session` on `session_start` events and clears on `session_end`/stop; tracks active sessions via `Set` so multiple concurrent sessions are handled (last-stamped persists; cleared only when zero remain). 45 new tests across 7 files. Pre-existing flake: `claude-code tailer.test.ts` "emits session_end on file rotation and a new session_start" reproduces on HEAD before WS-13 changes; passes on most reruns. Not a blocker.
- WS-20: merged (2026-04-21, commit `0c932b5`). Single-command onboarding. CLI adds `start`, `stop [--uninstall]`, `restart`, `doctor [--json]`; `login` takes positional token; `status` extended with `daemonRunning`, `servicePid`, `serviceUptimeSec`, `serviceInstalled`, `hookStates`, `detectedTools`. `apps/ingest/src/commands/onboard.ts` orchestrates: `detect.ts` probes `~/.claude/` + `~/.codex/` (honors `$CODEX_HOME`) + Cursor (macOS/Linux/Windows + `~/.cursor` fallback); invokes existing `installClaudeSessionStartHook` / `installCodexHook` / cursor `installHooks` / `enableTrailerHook` without redesigning them; migrates legacy `adapters.mock.enabled=true` to `{}` writing `~/.bm-pilot/config.json.bak-pre-ws20`; per-tool failures logged + continued. `service.ts` is a platform-dispatch abstraction with injectable `platform` + `exec` seam — `launchd.ts` renders from `infra/service-install/launchd.plist.tmpl` + `launchctl bootstrap gui/$UID ... / kickstart / bootout`; `systemd.ts` renders from `systemd.service.tmpl` + `systemctl --user enable --now` / `disable --now`; `windows.ts` uses `schtasks /Create /SC ONLOGON /TN Bematist /RL LIMITED` (wraps PowerShell logic). Service-install failure path spawns a detached daemon, writes PID to `~/.bm-pilot/daemon.pid`, `bm-pilot stop` SIGTERMs + waits 5s + SIGKILLs. `doctor.ts` runs config / token-format / `/healthz` reachability (critical) + tool detection / hook states / daemon + service (non-critical) with `--json` output. `freshConfig()` now returns `adapters: {}` (mock becomes opt-in); `install.sh` trailing hint updated to `login <token>` + `start`. Marketing `/install` page + dashboard `EmptyState` updated to 3-command copy. `daemon.ts` gains `trimDaemonLogIfLarge(path, 10MB)` (halves file when over; no background rotation). Marker convention is ASCII `[ok]` / `[skip]` / `[fail]` — no emoji. Manual OS acceptance (launchd/systemd/schtasks survive logout/reboot) is WS-15's job; CI covers dispatch logic only — documented at `apps/ingest/docs/onboard-manual-tests.md`. +45 tests; full suite 460/460.
- WS-15: todo (blocked on WS-14 → Railway provisioning; WS-20 unblocks developer-side onboarding)
- WS-21: todo — **NEXT**. Historical session backfill (`bm-pilot backfill`). Reads existing `~/.claude/projects/**/*.jsonl` + `~/.codex/sessions/**/rollout-*.jsonl` from byte 0, emits through the live parse/upload path, bumps offsets to EOF so the tailer doesn't re-emit. Cursor skipped (hook-driven). Full spec §WS-21 above.
- WS-19: merged (2026-04-21, commit `e8d9eff`). Fixes 3-way mismatch between admin mint-key, CLI regex, and API parser that made every minted ingest key unusable. Admin `mintIngestKeyForDeveloper` in `apps/web/app/admin/keys/actions.ts` now emits `bm_<fullOrgUUID>_<suffix>_<secret>` (4 underscore-separated parts matching `apps/api/src/auth/verifyIngestKey.ts#parseBearer`), stores DB id as `bm_<fullOrgUUID>_<suffix>` (no truncation of orgId), and hashes ONLY the secret (`sha256(secret)` — not `sha256(keyId.secret)`). Secret alphabet switched from base64url to 64-hex chars so the parser's `_` split is unambiguous. CLI `KEY_PATTERN` in `apps/ingest/src/auth.ts` tightened to `^bm_<uuid>_[A-Za-z0-9]{8,64}_[A-Za-z0-9]{16,}$` — exact match with API. `apps/api/src/auth/verifyIngestKey.ts` promotes `parseBearer` + `sha256Hex` from `__test__` namespace to top-level exports; web consumes via `apps/web/lib/keyHash.ts` (local copy to avoid web→api bundle pulling `Bun.serve`). Install.sh bug: `DEFAULT_API_URL` was `http://localhost:8000` hardcoded at compile. Now `apps/ingest/scripts/install.sh` seeds `~/.bm-pilot/config.json` post-install with `apiUrl` substituted from the web's `/install.sh` route, which replaces the `{{API_URL}}` template literal with `INGEST_API_PUBLIC_URL` (preferred) or `INGEST_API_URL` (fallback) env var. Seed includes full `ConfigSchema.strict()` shape: `apiUrl`, `ingestKey:null`, `deviceId:<uuid>` (via `uuidgen` or `/proc/sys/kernel/random/uuid`), `adapters:{mock:{enabled:true}}`, `installedAt:<ISO>`. If neither env is set, literal `{{API_URL}}` passes through and install.sh falls back to `BM_PILOT_API_URL` env var or skips seeding (CLI will then default to localhost for dev). +15 tests; full suite 415/415. Orchestrator set `INGEST_API_PUBLIC_URL=https://api-production-2834.up.railway.app` on web service before merge.
- WS-18: merged (2026-04-21, commit `db09c68`). Auto-backfill GitHub repos on admin install callback. Previously `/admin/github/callback` only inserted the `github_installations` row; repo population depended entirely on the `installation.created` webhook, leading to "0 repos" until a later push. Now the callback also mints an installation token via JWT (RS256) + calls `GET /installation/repositories` (paginated) + upserts into `repos`. Best-effort: missing creds → short-circuit with `{ ok: false, reason: "missing-creds" }`; any network/DB error in mint/list/upsert → logged, not surfaced, redirect still returns `status=ok`. Architecture: `apps/web/lib/githubRepos.ts` copies the ~30-line JWT + list-repos + upsert helper (avoids a `apps/web → @bematist/api` dep that would drag `Bun.serve` + the full api router into Next.js 16's bundle graph). Route factored as `handleCallback(req, deps)` with a `CallbackDeps` DI seam mirroring WS-5's `WebhookRouteDeps`; `GET` is a 1-line wrapper building `productionDeps()` (lazy imports `@/lib/session` at request time so tests stay Postgres-free). +10 tests; full suite 400/400.
- WS-17: merged (2026-04-21, commit `f103dea`). Rename CLI binary from `bematist` to `bm-pilot` (temp name — final TBD by team). Scope: binary filenames in `apps/ingest/build.ts` (4 targets), `apps/ingest/scripts/install.sh`, `.github/workflows/release.yml`; state dir `~/.bematist/` → `~/.bm-pilot/`; all user-facing CLI help text; hook install commands (`bm-pilot capture-git-sha`, `bm-pilot cursor-hook`); env vars `BEMATIST_BINARY_BASE_URL` → `BM_PILOT_BINARY_BASE_URL`, `BEMATIST_INSTALL_DIR` → `BM_PILOT_INSTALL_DIR`, `BEMATIST_TOKEN` → `BM_PILOT_TOKEN`; dashboard install-instruction copy. PRESERVED: product name "Bematist" in brand, `@bematist/*` workspace names, `app_bematist` Postgres role, DB schema, `Bematist-Session` git trailer, `bematist_session_id` cursor payload reader, server-side `BEMATIST_MODEL_CACHE_DIR` + `BEMATIST_SERVICE`, logger prefixes in api/worker. 390 tests unchanged. 40 files, 125+/125-.
- WS-16: merged (2026-04-21, commit `38ca0a2`). Followup to WS-5 unblocking multi-tenant GitHub App onboarding. `POST /v1/webhooks/github` is now a static URL (no path param); `githubWebhookRoute(req, deps)` extracts `installation.id` from the HMAC-verified body; `ping` events short-circuit with `{ ok: true, event: "ping" }` 200; missing/invalid `installation.id` returns 400 `MISSING_INSTALLATION_ID`. Touched only `apps/api/src/github/webhook.ts`, `apps/api/src/index.ts`, and the two webhook-route test files. +2 tests; full suite 390/390. The GitHub App's webhook URL in production is `https://bm-pilot.up.railway.app/v1/webhooks/github`.
- WS-14: merged (2026-04-21, commits `478d5a0` + `841c1ef`). Railway IaC + CI/release pipelines + install.sh distribution. `infra/railway.json` declares 3 services (web/api/worker) pointing at `infra/Dockerfile.{web,api,worker}` (multi-stage `oven/bun:1.2-slim`, each deps stage copies all 9 workspace `package.json` files so `--frozen-lockfile` succeeds). Web uses `/install.sh` as healthcheck, API uses new `/healthz` route (re-exports `healthRoute`). `apps/web/package.json` `start` now respects `$PORT`. `apps/web/app/install.sh/route.ts` serves `apps/ingest/scripts/install.sh` (Dockerfile.web copies it to `apps/web/install-script/install.sh` at build; 3-candidate fallback for local dev + tests). `.github/workflows/ci.yml` runs lint/typecheck/test on every push/PR with a `pgvector/pgvector:pg16` service container; `.github/workflows/release.yml` tag-triggers (`v*.*.*`), cross-compiles all 4 binaries via `apps/ingest/build.ts`, generates `.sha256` sidecars, publishes via `softprops/action-gh-release@v2`. `install.sh` default `BASE_URL` → `https://github.com/pella-labs/bematist-simplified/releases/latest/download`; Windows branch now functional (targets `bematist-win32-x64.exe`). Placeholder domain replaced across `packages/ui/src/brand.config.ts` + `apps/web/components/dashboard/EmptyState.tsx` with `bm-pilot.up.railway.app`. Service-install templates shipped: `infra/service-install/{launchd.plist.tmpl,systemd.service.tmpl,windows-service-install.ps1}` — WS-20 wires them up via `bm-pilot start`. 6 new tests (3 `/install.sh` route + 3 `/healthz`); full suite 388/388. Railway provisioning done out-of-band: project `bm-pilot` (id `389d7ad3-1d55-445f-bc87-647eec10e9e5`) + Postgres already exist; orchestrator links services + sets env vars post-push.

**Decisions ratified by the user before context clear:**

- Cursor hooks are installed silently on first `bematist run` with a one-time terminal prompt; choice persisted in `~/.bematist/config.json`.
- Blob storage is deferred; prompt/response text lives inline in Postgres for dogfood. When it migrates, destination is Tigris (S3-compatible), not R2.
- Embedding default is MiniLM (`@xenova/transformers`, `all-MiniLM-L6-v2`, 384-dim). OpenAI is an opt-in per-org upgrade via future workstream.
- GitHub App install + webhook handler are lifted from `../analytics-research/` then stripped; three-layer outcome attribution, secret rotation, reconciliation crons, and everything Clio-related are dropped.
- Trailer-based outcome attribution uses git's `prepare-commit-msg` hook via a global `core.hooksPath`. **No commit amending. No history rewriting.** Opt-in via `bematist git enable`.
- Every signed-in user linked to a `developer` row gets a `/me` dashboard. Admins additionally see org-wide views. A single user is typically both.
- Custom domain (`bematist.dev`) is out of scope for v1 — that domain is occupied by the existing analytics-research project. v1 uses a Railway subdomain.

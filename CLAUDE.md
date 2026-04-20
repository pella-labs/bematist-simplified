# bematist-simplified

Multi-tenant SaaS that captures Claude Code, Codex CLI, and Cursor telemetry from developers, links prompts to merged commits/PRs via a GitHub App, and shows managers + developers per-person usage, outcomes, and subscription-vs-API cost delta. Target: internal dogfood (5 devs on the user's team — 4 macOS + 1 Windows) → client pilot (70–100 engineers).

**Read [`plan.md`](./plan.md) before taking any action.** It is the source of truth for scope, architecture, data model, wire format, reuse boundary, the 15-workstream breakdown, and current status. `CLAUDE.md` (this file) only encodes *how* we work. `plan.md` encodes *what* we're building.

## Context handoff — read this first on a fresh session

The lead LLM is a long-running orchestrator that survives context clears by re-reading these files. If you're picking up mid-project:

1. Open `plan.md` and jump to the **Current status** table at the bottom — it tells you which workstreams are `todo`, `in-progress`, `review`, or `merged`.
2. If the user says "continue" or similar, the next action is usually to start the next-ready workstream per that table.
3. The sibling directory `../analytics-research/` is the previous (overengineered) implementation. You may read its **code** (not `.md` files) per the reuse boundary in `plan.md` §Reuse. Do not import its architecture wholesale.
4. The GitHub repo is `github.com/pella-labs/bematist-simplified` (public, owned by the `pella-labs` org). Hosting: Railway. Current deployed domain: Railway subdomain (custom domain deferred).
5. Storage for blobs post-MVP: Tigris (user has an account). Not R2.
6. The user's 5 dogfood devs run macOS (×4) and Windows (×1). Windows caveats: Codex CLI hooks are disabled → Codex adapter relies on rollout JSONL tail only on that OS. Claude Code hooks and Cursor hooks both work on Windows.

## Non-goals (enforce ruthlessly)

- No compliance/PII redaction, no privacy tiers, no Clio-style on-device abstraction
- No self-host, no distro packaging (Homebrew/apt/choco), no SLSA/cosign signing
- No ClickHouse, Kafka, Redpanda, Redis Streams, PgBoss for per-event work
- No scoring framework with "locked math" or 500-case eval — ship raw data, iterate after
- No adapters beyond Claude Code, Codex CLI, Cursor
- No speculative features. If plan.md doesn't list it, don't build it.

If you catch yourself lifting architecture from `../analytics-research/`, pause and ask whether it's on the keep-list in `plan.md` §"Reuse". Most of it is not.

## Orchestration protocol

**The lead LLM orchestrates. It does not write production code.** All implementation is delegated to subagents working in isolated worktrees.

### Workflow per workstream

1. Lead picks next workstream from `plan.md` whose dependencies are satisfied.
2. Lead spawns an `implementer` subagent with:
   - `isolation: "worktree"` — subagent works on a clean branch `feat/ws-<n>-<slug>`
   - Prompt references the exact workstream section in `plan.md`
   - Explicit list of files the workstream may create/modify (see `plan.md` §Workstream files)
3. Subagent implements + tests, commits on its branch, returns worktree path.
4. Lead reviews the diff (reads files, checks contracts match `packages/contracts`).
5. Lead merges the branch into `main` (fast-forward or squash), prunes the worktree.
6. Lead updates `plan.md` workstream status: `todo → in-progress → merged`.

### Merge rules

- Tests must pass locally before merge. No `--no-verify`, no `--no-gpg-sign`.
- If a pre-commit hook fails, fix the root cause; do not amend-bypass.
- Merge to `main` only from the orchestrator session, never from a subagent.
- If two parallel workstreams create conflicts, the orchestrator resolves them; do not delegate conflict resolution to a subagent.
- Never force-push `main`.

### Parallelism

- All workstreams inside a wave run in parallel as separate `implementer` subagents.
- Wave N+1 does not start until all Wave N workstreams are merged.
- Shared contracts (`packages/contracts`) stabilize at the end of Wave 0 and change only via a dedicated contract-update workstream (breaks the parallelism rule — do it alone).

### When a subagent needs something outside its scope

The subagent must stop and report back. The lead then either (a) expands the workstream, or (b) creates a new workstream in `plan.md` with proper dependencies. Never let a subagent silently edit files outside its assigned paths.

## Stack (fixed — do not debate in workstreams)

- **Runtime**: Bun 1.2+ (root-pinned in `package.json`)
- **Language**: TypeScript strict
- **Monorepo**: Bun workspaces, no Turborepo/Nx
- **Web**: Next.js 16 (app router, RSC), React 19
- **UI**: Tailwind v4 + shadcn/ui, Motion for animations
- **Auth**: Better-Auth + GitHub OAuth only
- **DB**: Postgres 16 + pgvector, Drizzle ORM, raw SQL for RLS policies
- **Ingest API**: `Bun.serve`, no Express/Hono/Elysia
- **Ingest binary**: Bun compiled via `bun build --compile`
- **Lint/format**: Biome (not ESLint/Prettier)
- **Tests**: `bun test` co-located as `*.test.ts`
- **Deploy**: Railway for all services (web, api, worker, postgres)
- **Blob** (post-MVP): Tigris (S3-compatible)

## Coding rules

- Default to writing **no comments**. Only add one when the WHY is non-obvious (hidden constraint, subtle invariant, workaround for a specific bug). Well-named identifiers explain WHAT.
- **No emojis** in code or docs unless explicitly requested by the user.
- **No backwards-compat shims**: this is a greenfield project. If something is unused, delete it.
- **No speculative abstractions**: three similar lines is better than a premature abstraction.
- **Trust internal code**: only validate at system boundaries (HTTP, CLI args, DB rows coming from untrusted input).
- **Edit over Write**: prefer modifying existing files; create new files only when a workstream explicitly adds one.
- **Shared wire formats live in `packages/contracts`** as Zod schemas. Any cross-component type must route through there. Inline duplication is a merge blocker.
- **DB access**: all SQL goes through Drizzle or parameterized raw SQL. No string concatenation.
- **RLS is enforced at the DB level.** Application code must never bypass RLS via a superuser role except in migrations and the webhook receiver (which sets `app.current_org_id` from the installation).
- **Bun-first**: prefer `Bun.file`, `Bun.serve`, `Bun.redis`, `Bun.$` where available. Don't pull in node-fetch, express, etc.

## Testing rules

- Every workstream that touches runtime behavior ships `*.test.ts` files for its key paths.
- No mocking the database for ingest/webhook tests — use a local Postgres via docker-compose.
- Never commit skipped (`.skip`) tests without a linked explanation comment.
- Critical paths with merge-blocking tests:
  - Event schema validation (reject unknown fields, type coerce, required-field presence)
  - Webhook HMAC verification (dual-accept)
  - RLS cross-tenant probe (query from wrong org → 0 rows)
  - JSONL parser dedup (same `requestId` must not double-count)
  - Cost calc (fixed pricing table, pinned expected values)

## Agents

- **Explore** — use for open-ended codebase or web research that spans >3 lookups.
- **implementer** — use for all code-writing workstreams. Pass the workstream section of `plan.md` verbatim as context.
- **Plan** — use when a workstream boundary is unclear and needs architectural triage before implementation.
- **general-purpose** — use for web research or cross-cutting audits.

Always specify `isolation: "worktree"` for `implementer` spawns unless the task is read-only.

## Reuse boundary (from `../analytics-research/`)

Permitted to lift code from (code only, never `.md`):
- `apps/collector/src/adapters/claude-code/parsers/parseSessionFile.ts` — hardened JSONL parser
- `apps/web/lib/auth.ts` + `apps/web/lib/auth-bridge.ts` — Better-Auth + first-login bridge
- `apps/ingest/src/github-app/webhookRoute.ts` + `verifyWithRotation.ts` — HMAC webhook handler
- `apps/ingest/src/github-app/installationResolver.ts` + `token-cache.ts` — installation token minting
- `apps/web/app/(marketing)/home/page.tsx` and its component tree — landing page style
- `packages/schema/postgres/custom/0002_rls_org_isolation.sql` — RLS policy pattern

Everything else: do not lift. Rebuild minimally per `plan.md`.

## What breaks this project

In order of severity:
1. Scope creep — a workstream delivering "while I'm here" features not in `plan.md`.
2. Two workstreams editing the same file in parallel without a contract boundary.
3. A workstream depending on another workstream's internal types instead of `packages/contracts`.
4. Subagent editing `main` or another workstream's branch.
5. Lifting privacy/compliance code from the old repo "because it was already there."

The orchestrator is the last line of defense on each of these.

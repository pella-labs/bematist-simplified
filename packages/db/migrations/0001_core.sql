-- Core relational tables. Partitioned tables (events, prompts) live in 0002.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  better_auth_user_id text NOT NULL,
  email text NOT NULL,
  name text,
  role text NOT NULL CHECK (role IN ('admin','member')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_better_auth_user_id_uq ON users(better_auth_user_id);
CREATE UNIQUE INDEX users_org_email_uq ON users(org_id, email);

CREATE TABLE developers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  email text NOT NULL,
  name text,
  subscription_claude text,
  subscription_codex text,
  subscription_cursor text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX developers_org_email_uq ON developers(org_id, email);

CREATE TABLE ingest_keys (
  id text PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  developer_id uuid NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  key_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX ingest_keys_developer_idx ON ingest_keys(developer_id);

CREATE TABLE github_installations (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  installation_id bigint NOT NULL UNIQUE,
  webhook_secret text,
  token_ref text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX github_installations_org_idx ON github_installations(org_id);

CREATE TABLE repos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  installation_id bigint NOT NULL,
  github_repo_id bigint NOT NULL UNIQUE,
  name text NOT NULL,
  default_branch text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX repos_org_idx ON repos(org_id);

CREATE TABLE github_prs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  repo_id uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number integer NOT NULL,
  title text NOT NULL,
  author_github_login text,
  state text NOT NULL,
  merged_at timestamptz,
  base_sha text,
  head_sha text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX github_prs_repo_number_uq ON github_prs(repo_id, number);
CREATE INDEX github_prs_org_idx ON github_prs(org_id);

CREATE TABLE github_commits (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  repo_id uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  sha text NOT NULL,
  author_email text,
  author_github_login text,
  message text,
  branch text,
  committed_at timestamptz,
  pushed_at timestamptz,
  pr_id uuid REFERENCES github_prs(id) ON DELETE SET NULL,
  PRIMARY KEY (repo_id, sha)
);
CREATE INDEX github_commits_org_idx ON github_commits(org_id);
CREATE INDEX github_commits_committed_at_idx ON github_commits(committed_at);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  developer_id uuid NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('claude-code','codex','cursor')),
  source_session_id text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  cwd text,
  git_branch text,
  git_sha_at_start text,
  model_hint text,
  client_version text
);
CREATE UNIQUE INDEX sessions_org_source_source_session_uq
  ON sessions(org_id, source, source_session_id);
CREATE INDEX sessions_developer_started_at_idx ON sessions(developer_id, started_at);

CREATE TABLE prompt_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  centroid vector(384),
  size integer NOT NULL DEFAULT 0,
  label text,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session_commit_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  commit_sha text NOT NULL,
  signal text NOT NULL CHECK (signal IN ('cwd_time','trailer','webhook_scan')),
  confidence numeric(4,3),
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX session_commit_links_uq
  ON session_commit_links(session_id, commit_sha, signal);
CREATE INDEX session_commit_links_commit_idx ON session_commit_links(commit_sha);

CREATE TABLE pricing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pricing_version text NOT NULL,
  model text NOT NULL,
  provider text NOT NULL,
  input_per_mtok numeric(10,4),
  output_per_mtok numeric(10,4),
  cache_read_per_mtok numeric(10,4),
  cache_write_per_mtok numeric(10,4),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz
);
CREATE UNIQUE INDEX pricing_version_model_from_uq
  ON pricing(pricing_version, model, effective_from);
CREATE INDEX pricing_model_idx ON pricing(model);

CREATE TABLE webhook_deliveries (
  delivery_id text PRIMARY KEY,
  installation_id bigint,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_received_at_idx ON webhook_deliveries(received_at);

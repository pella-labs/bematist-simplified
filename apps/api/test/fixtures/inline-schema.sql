-- WS-1 integration seam. Delete this file once `@bematist/db` exports runMigrations
-- with the real schema. Tables here are the minimal subset WS-2 needs to exercise
-- its own code paths: events, ingest_keys, pricing. No RLS policies are defined
-- aside from enabling row-level security on events, so the RLS test validates that
-- the write path sets `app.current_org_id` correctly.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS ingest_keys (
  id            text PRIMARY KEY,
  org_id        uuid        NOT NULL,
  developer_id  uuid        NOT NULL,
  key_sha256    text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);

CREATE TABLE IF NOT EXISTS pricing (
  id                    bigserial PRIMARY KEY,
  pricing_version       text        NOT NULL,
  model                 text        NOT NULL,
  provider              text        NOT NULL,
  input_per_mtok        numeric     NOT NULL,
  output_per_mtok       numeric     NOT NULL,
  cache_read_per_mtok   numeric     NOT NULL DEFAULT 0,
  cache_write_per_mtok  numeric     NOT NULL DEFAULT 0,
  effective_from        timestamptz NOT NULL,
  effective_to          timestamptz
);

CREATE INDEX IF NOT EXISTS pricing_model_time ON pricing (model, effective_from DESC);

CREATE TABLE IF NOT EXISTS events (
  id                     bigserial,
  client_event_id        uuid        NOT NULL,
  org_id                 uuid        NOT NULL,
  developer_id           uuid        NOT NULL,
  session_id             text        NOT NULL,
  event_seq              integer     NOT NULL,
  ts                     timestamptz NOT NULL,
  kind                   text        NOT NULL,
  tool_name              text,
  tool_input             jsonb,
  tool_output            jsonb,
  input_tokens           integer,
  output_tokens          integer,
  cache_read_tokens      integer,
  cache_creation_tokens  integer,
  cost_usd               numeric,
  pricing_version        text,
  duration_ms            integer,
  success                boolean,
  raw                    jsonb,
  cwd                    text,
  git_branch             text,
  git_sha                text,
  model                  text,
  source                 text        NOT NULL,
  source_version         text        NOT NULL,
  client_version         text        NOT NULL,
  source_session_id      text        NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, ts)
);

CREATE UNIQUE INDEX IF NOT EXISTS events_dedup
  ON events (org_id, session_id, event_seq, client_event_id);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS events_org_isolation ON events;
CREATE POLICY events_org_isolation ON events
  USING (org_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (org_id::text = current_setting('app.current_org_id', true));

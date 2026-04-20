-- Partitioned event-scale tables: events (by ts) and prompts (by created_at).
-- Monthly native range partitions. ensure_partitions(n) materializes the next n
-- months in one go (idempotent). We seed the current + next 3 months on first
-- migrate so fresh installs can accept writes immediately.

CREATE TABLE events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  developer_id uuid NOT NULL,
  session_id uuid NOT NULL,
  event_seq integer NOT NULL,
  ts timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'user_prompt','assistant_response','tool_call','tool_result','session_start','session_end'
  )),
  tool_name text,
  tool_input jsonb,
  tool_output jsonb,
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  cache_creation_tokens integer,
  cost_usd numeric(12,6),
  duration_ms integer,
  success boolean,
  raw jsonb,
  prompt_id uuid,
  client_event_id uuid NOT NULL,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

-- Dedup is per-partition because (org_id, session_id, event_seq, client_event_id)
-- must include the partition key in a unique index on a partitioned table.
CREATE UNIQUE INDEX events_dedup_uq
  ON events(org_id, session_id, event_seq, client_event_id, ts);
CREATE INDEX events_session_ts_idx ON events(session_id, ts);

CREATE TABLE prompts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  session_id uuid NOT NULL,
  prompt_index integer NOT NULL,
  prompt_text text NOT NULL,
  prompt_sha256 text NOT NULL,
  embedding vector(384),
  cluster_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX prompts_session_idx ON prompts(session_id, prompt_index);
CREATE INDEX prompts_sha256_idx ON prompts(prompt_sha256);

-- HNSW index on the parent table is valid for partitioned tables — Postgres
-- creates a matching index on each child partition as it is attached.
CREATE INDEX prompts_embedding_hnsw
  ON prompts USING hnsw (embedding vector_cosine_ops);

-- Create a single month's partition for both events and prompts if missing.
-- month_start must be the first day of a month (00:00 UTC).
CREATE OR REPLACE FUNCTION create_monthly_partition(month_start date) RETURNS void AS $$
DECLARE
  month_end date := (month_start + interval '1 month')::date;
  suffix text := to_char(month_start, 'YYYYMM');
  events_name text := format('events_%s', suffix);
  prompts_name text := format('prompts_%s', suffix);
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
    events_name, month_start, month_end
  );
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF prompts FOR VALUES FROM (%L) TO (%L)',
    prompts_name, month_start, month_end
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ensure_partitions(months_ahead integer) RETURNS void AS $$
DECLARE
  cur date := date_trunc('month', now())::date;
  i integer := 0;
BEGIN
  WHILE i <= months_ahead LOOP
    PERFORM create_monthly_partition((cur + (i || ' months')::interval)::date);
    i := i + 1;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Row-Level Security on every org-scoped table. The app connects as a role
-- that inherits NOBYPASSRLS; migrations + the GitHub webhook receiver are the
-- only callers that bypass via SUPERUSER (see getAdminDb in src/client.ts).
--
-- Pattern:
--   1. Ensure the app role (app_bematist) exists.
--   2. ENABLE + FORCE row level security on every org-scoped table.
--   3. Attach org_isolation policy keyed on app_current_org().
--
-- Partitioned tables (events, prompts): policies attach to the parent and
-- Postgres inherits them to every partition automatically.

DO $$ BEGIN
  CREATE ROLE app_bematist NOBYPASSRLS NOSUPERUSER LOGIN PASSWORD 'app_bematist_dev';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT USAGE ON SCHEMA public TO app_bematist;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_bematist;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_bematist;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_bematist;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_bematist;

CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
  t text;
  org_tables text[] := ARRAY[
    'users',
    'developers',
    'ingest_keys',
    'github_installations',
    'repos',
    'github_prs',
    'github_commits',
    'sessions',
    'events',
    'prompts',
    'prompt_clusters',
    'session_commit_links'
  ];
BEGIN
  FOREACH t IN ARRAY org_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())',
      t
    );
  END LOOP;
END $$;

-- orgs, pricing, webhook_deliveries are intentionally not RLS-scoped:
-- orgs is the tenant table, pricing is global (versioned catalog), and
-- webhook_deliveries is a write-only audit log that the webhook receiver
-- (running as admin) writes before it knows an org.

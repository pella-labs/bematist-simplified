-- Better-Auth owned tables. Kept in packages/auth (not packages/db) because
-- the auth package is the sole consumer and WS-1's DDL is frozen. Apply via
-- applyAuthMigrations(url) from @bematist/auth/migrations.
--
-- Tables are NOT RLS-scoped: Better-Auth manages its own identity rows, and
-- authorization to the tenant-scoped world happens through
-- packages/db -> users (org_id, better_auth_user_id).

CREATE TABLE IF NOT EXISTS "better_auth_user" (
  "id"             text        PRIMARY KEY,
  "name"           text        NOT NULL,
  "email"          text        NOT NULL UNIQUE,
  "email_verified" boolean     NOT NULL DEFAULT false,
  "image"          text,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "better_auth_session" (
  "id"         text        PRIMARY KEY,
  "user_id"    text        NOT NULL REFERENCES "better_auth_user"("id") ON DELETE CASCADE,
  "token"      text        NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "better_auth_session_user_id_idx"
  ON "better_auth_session" ("user_id");
CREATE INDEX IF NOT EXISTS "better_auth_session_token_idx"
  ON "better_auth_session" ("token");

CREATE TABLE IF NOT EXISTS "better_auth_account" (
  "id"                        text        PRIMARY KEY,
  "user_id"                   text        NOT NULL REFERENCES "better_auth_user"("id") ON DELETE CASCADE,
  "account_id"                text        NOT NULL,
  "provider_id"               text        NOT NULL,
  "access_token"              text,
  "refresh_token"             text,
  "id_token"                  text,
  "access_token_expires_at"   timestamptz,
  "refresh_token_expires_at"  timestamptz,
  "scope"                     text,
  "password"                  text,
  "created_at"                timestamptz NOT NULL DEFAULT now(),
  "updated_at"                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "better_auth_account_provider_account_uniq"
  ON "better_auth_account" ("provider_id", "account_id");
CREATE INDEX IF NOT EXISTS "better_auth_account_user_id_idx"
  ON "better_auth_account" ("user_id");

CREATE TABLE IF NOT EXISTS "better_auth_verification" (
  "id"         text        PRIMARY KEY,
  "identifier" text        NOT NULL,
  "value"      text        NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "better_auth_verification_identifier_idx"
  ON "better_auth_verification" ("identifier");

-- Grant the app role access so signed-in sessions can be read from
-- application connections (Better-Auth queries run as the application user).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_bematist') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      "better_auth_user",
      "better_auth_session",
      "better_auth_account",
      "better_auth_verification"
    TO app_bematist;
  END IF;
END $$;

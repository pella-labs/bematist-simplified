import * as schema from "@bematist/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// Better-Auth owns its own identity tables. They live in packages/auth's
// migration file (not packages/db) because the auth package is the sole
// consumer and WS-1's migrations are frozen. The Drizzle schema below is
// declared inline so Better-Auth's drizzle adapter can resolve tables.
export const betterAuthUser = pgTable("better_auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const betterAuthSession = pgTable("better_auth_session", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const betterAuthAccount = pgTable("better_auth_account", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const betterAuthVerification = pgTable("better_auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface AuthServerConfig {
  databaseUrl: string;
  secret: string;
  baseURL: string;
  githubClientId: string;
  githubClientSecret: string;
  trustedOrigins?: string[];
}

function readConfigFromEnv(): AuthServerConfig {
  const databaseUrl = process.env.DATABASE_URL;
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = process.env.BETTER_AUTH_URL;
  const githubClientId = process.env.GITHUB_CLIENT_ID ?? "";
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET ?? "";
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");
  if (!baseURL) throw new Error("BETTER_AUTH_URL is not set");
  const trusted = process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    databaseUrl,
    secret,
    baseURL,
    githubClientId,
    githubClientSecret,
    ...(trusted ? { trustedOrigins: trusted } : {}),
  };
}

function buildAuth(config: AuthServerConfig) {
  const pg = postgres(config.databaseUrl, { max: 5, prepare: false });
  const db = drizzle(pg, {
    schema: {
      ...schema,
      betterAuthUser,
      betterAuthSession,
      betterAuthAccount,
      betterAuthVerification,
    },
  });

  const adapterSchema = {
    user: betterAuthUser,
    session: betterAuthSession,
    account: betterAuthAccount,
    verification: betterAuthVerification,
  };

  const trustedOrigins = [
    config.baseURL,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    ...(config.trustedOrigins ?? []),
  ];

  return betterAuth({
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: adapterSchema,
    }),
    socialProviders: {
      github: {
        clientId: config.githubClientId,
        clientSecret: config.githubClientSecret,
        scope: ["read:user", "public_repo"],
      },
    },
    emailAndPassword: { enabled: false },
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof buildAuth>;

type AuthGlobals = typeof globalThis & {
  __bematist_auth?: Auth;
};

export function getAuth(): Auth {
  const g = globalThis as AuthGlobals;
  if (!g.__bematist_auth) {
    g.__bematist_auth = buildAuth(readConfigFromEnv());
  }
  return g.__bematist_auth;
}

export function createAuth(config: AuthServerConfig): Auth {
  return buildAuth(config);
}

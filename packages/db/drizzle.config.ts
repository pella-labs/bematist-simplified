const config = {
  schema: "./schema.ts",
  out: "./migrations",
  dialect: "postgresql" as const,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://bematist:bematist@localhost:5432/bematist",
  },
};

export default config;

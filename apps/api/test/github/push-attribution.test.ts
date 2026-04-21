import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "bun";
import type { Sql } from "postgres";
import { startServer } from "../../src/index";
import { createTestSchema, type TestSchema } from "../fixtures/db";
import { pushEvent, seedInstallation } from "./fixtures";

const SECRET = "push-attribution-secret";

let db: TestSchema;
let sql: Sql;
let adminSql: Sql;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  db = await createTestSchema();
  sql = db.sql;
  adminSql = db.adminSql;
  server = startServer({ sql, adminSql, port: 0, githubWebhookSecret: SECRET });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await db.close();
});

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

async function postPush(opts: { body: unknown }): Promise<Response> {
  const bodyStr = JSON.stringify(opts.body);
  return fetch(`${baseUrl}/v1/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": sign(bodyStr),
    },
    body: bodyStr,
  });
}

describe("push attribution (trailer + webhook_scan)", () => {
  it("creates a trailer link on push when commit message carries Bematist-Session", async () => {
    const seeded = await seedInstallation(sql);
    // Seed a developer + session within orgId.
    const sessionId = randomUUID();
    const developerId = randomUUID();
    const commitSha = `a${"0".repeat(39)}`;
    await adminSql`
      INSERT INTO developers (id, org_id, email) VALUES (${developerId}, ${seeded.orgId}, 'alice@ex.com')
    `;
    await adminSql`
      INSERT INTO sessions (id, org_id, developer_id, source, source_session_id, started_at)
      VALUES (${sessionId}, ${seeded.orgId}, ${developerId}, 'claude-code', 'src-sess', now())
    `;
    const res = await postPush({
      body: pushEvent({
        installationId: seeded.installationId,
        repoId: 90001,
        commits: [
          {
            id: commitSha,
            message: `feat: do the thing\n\nBematist-Session: ${sessionId}\n`,
            timestamp: "2026-04-20T12:00:00Z",
            author: { email: "alice@ex.com", name: "Alice" },
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const links = await adminSql<{ signal: string; session_id: string }[]>`
      SELECT signal, session_id FROM session_commit_links WHERE commit_sha = ${commitSha}
      ORDER BY signal
    `;
    const signals = links.map((l) => l.signal);
    expect(signals).toContain("trailer");
    const trailer = links.find((l) => l.signal === "trailer");
    expect(trailer?.session_id).toBe(sessionId);
  });

  it("creates a webhook_scan link on push when author+time match but no trailer", async () => {
    const seeded = await seedInstallation(sql);
    const developerId = randomUUID();
    const sessionId = randomUUID();
    const email = "bob@ex.com";
    const commitSha = `b${"0".repeat(39)}`;
    const now = new Date("2026-04-20T12:00:00Z");
    const sessionStart = new Date(now.getTime() - 5 * 60 * 1000);
    await adminSql`
      INSERT INTO developers (id, org_id, email) VALUES (${developerId}, ${seeded.orgId}, ${email})
    `;
    await adminSql`
      INSERT INTO sessions (id, org_id, developer_id, source, source_session_id, started_at, ended_at)
      VALUES (${sessionId}, ${seeded.orgId}, ${developerId}, 'claude-code', 'scan-sess', ${sessionStart}, ${now})
    `;
    const res = await postPush({
      body: pushEvent({
        installationId: seeded.installationId,
        repoId: 90002,
        commits: [
          {
            id: commitSha,
            message: "no trailer here\n",
            timestamp: now.toISOString(),
            author: { email, name: "Bob" },
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const links = await adminSql<{ signal: string; session_id: string }[]>`
      SELECT signal, session_id FROM session_commit_links WHERE commit_sha = ${commitSha}
    `;
    const signals = links.map((l) => l.signal);
    expect(signals).toContain("webhook_scan");
    expect(links.find((l) => l.signal === "webhook_scan")?.session_id).toBe(sessionId);
  });

  it("is a no-op (no links) when push contains no commits", async () => {
    const seeded = await seedInstallation(sql);
    const res = await postPush({
      body: pushEvent({
        installationId: seeded.installationId,
        repoId: 90003,
        commits: [],
      }),
    });
    expect(res.status).toBe(200);
    const links = await adminSql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM session_commit_links
      WHERE commit_sha = ${"deadbeef".repeat(5)}
    `;
    expect(links[0]?.c).toBe(0);
  });
});

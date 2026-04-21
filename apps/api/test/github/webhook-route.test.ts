import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { Server } from "bun";
import type { Sql } from "postgres";
import { startServer } from "../../src/index";
import { createTestSchema, type TestSchema } from "../fixtures/db";
import {
  installationEvent,
  installationRepositoriesEvent,
  pullRequestEvent,
  pushEvent,
  seedInstallation,
} from "./fixtures";

const SECRET = "github-webhook-test-secret";

let db: TestSchema;
let sql: Sql;
let adminSql: Sql;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  db = await createTestSchema();
  sql = db.sql;
  adminSql = db.adminSql;
  server = startServer({
    sql,
    adminSql,
    port: 0,
    githubWebhookSecret: SECRET,
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await db.close();
});

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function postWebhook(opts: {
  installationId: number;
  event: string;
  delivery?: string;
  body: unknown;
  signature?: string | null;
}): Promise<Response> {
  const bodyStr = JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": opts.event,
    "x-github-delivery": opts.delivery ?? crypto.randomUUID(),
  };
  const sig = opts.signature === undefined ? sign(bodyStr) : opts.signature;
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  return fetch(`${baseUrl}/v1/webhooks/github`, {
    method: "POST",
    headers,
    body: bodyStr,
  });
}

describe("POST /v1/webhooks/github", () => {
  it("rejects bad HMAC with 401", async () => {
    const seeded = await seedInstallation(sql);
    const res = await postWebhook({
      installationId: seeded.installationId,
      event: "push",
      body: pushEvent({ installationId: seeded.installationId }),
      signature: `sha256=${"0".repeat(64)}`,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("BAD_SIGNATURE");
  });

  it("rejects missing signature with 401", async () => {
    const seeded = await seedInstallation(sql);
    const res = await postWebhook({
      installationId: seeded.installationId,
      event: "push",
      body: pushEvent({ installationId: seeded.installationId }),
      signature: null,
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown installation", async () => {
    const body = pushEvent({ installationId: 99_999_999 });
    const res = await postWebhook({
      installationId: 99_999_999,
      event: "push",
      body,
    });
    expect(res.status).toBe(404);
  });

  it("dedups identical X-GitHub-Delivery", async () => {
    const seeded = await seedInstallation(sql);
    const delivery = crypto.randomUUID();
    const body = pushEvent({
      installationId: seeded.installationId,
      repoId: 20001,
      commits: [
        {
          id: "1".repeat(40),
          message: "dedup test",
          timestamp: "2026-04-03T00:00:00Z",
          author: { email: "d@ex.com", name: "D" },
        },
      ],
    });
    const first = await postWebhook({
      installationId: seeded.installationId,
      event: "push",
      delivery,
      body,
    });
    expect(first.status).toBe(200);
    const second = await postWebhook({
      installationId: seeded.installationId,
      event: "push",
      delivery,
      body,
    });
    expect(second.status).toBe(200);
    const j = (await second.json()) as { deduped?: boolean };
    expect(j.deduped).toBe(true);

    // Only one commit inserted.
    const rows = await adminSql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM github_commits WHERE sha = ${"1".repeat(40)}
    `;
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("push event upserts 2 commits with authors and branch", async () => {
    const seeded = await seedInstallation(sql);
    const commits = [
      {
        id: "2".repeat(40),
        message: "first commit",
        timestamp: "2026-04-05T12:00:00Z",
        author: { email: "bob@ex.com", name: "Bob", username: "bob" },
      },
      {
        id: "3".repeat(40),
        message: "second commit",
        timestamp: "2026-04-05T12:05:00Z",
        author: { email: "bob@ex.com", name: "Bob", username: "bob" },
      },
    ];
    const res = await postWebhook({
      installationId: seeded.installationId,
      event: "push",
      body: pushEvent({
        installationId: seeded.installationId,
        repoId: 20100,
        commits,
        ref: "refs/heads/feature/x",
      }),
    });
    expect(res.status).toBe(200);
    const rows = await adminSql<
      {
        sha: string;
        author_email: string;
        author_github_login: string;
        branch: string;
        committed_at: Date;
      }[]
    >`
      SELECT sha, author_email, author_github_login, branch, committed_at
      FROM github_commits
      WHERE sha IN (${commits[0]?.id ?? ""}, ${commits[1]?.id ?? ""})
      ORDER BY committed_at
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.author_email).toBe("bob@ex.com");
    expect(rows[0]?.author_github_login).toBe("bob");
    expect(rows[0]?.branch).toBe("feature/x");
    expect(rows[0]?.committed_at.toISOString()).toBe("2026-04-05T12:00:00.000Z");
  });

  it("pull_request.opened creates github_prs row with state=open, merged_at=null", async () => {
    const seeded = await seedInstallation(sql);
    const res = await postWebhook({
      installationId: seeded.installationId,
      event: "pull_request",
      body: pullRequestEvent({
        installationId: seeded.installationId,
        repoId: 20200,
        action: "opened",
        number: 42,
      }),
    });
    expect(res.status).toBe(200);
    const rows = await adminSql<{ state: string; merged_at: Date | null; number: number }[]>`
      SELECT state, merged_at, number FROM github_prs WHERE number = 42
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("open");
    expect(rows[0]?.merged_at).toBeNull();
  });

  it("pull_request.closed merged=true sets merged_at", async () => {
    const seeded = await seedInstallation(sql);
    // open first
    await postWebhook({
      installationId: seeded.installationId,
      event: "pull_request",
      body: pullRequestEvent({
        installationId: seeded.installationId,
        repoId: 20300,
        action: "opened",
        number: 7,
      }),
    });
    // close merged
    const res = await postWebhook({
      installationId: seeded.installationId,
      event: "pull_request",
      body: pullRequestEvent({
        installationId: seeded.installationId,
        repoId: 20300,
        action: "closed",
        number: 7,
        merged: true,
        mergedAt: "2026-04-06T09:30:00Z",
      }),
    });
    expect(res.status).toBe(200);
    const rows = await adminSql<{ state: string; merged_at: Date | null }[]>`
      SELECT state, merged_at FROM github_prs WHERE number = 7
    `;
    expect(rows[0]?.state).toBe("closed");
    expect(rows[0]?.merged_at?.toISOString()).toBe("2026-04-06T09:30:00.000Z");
  });

  it("pull_request.closed merged=false leaves merged_at null", async () => {
    const seeded = await seedInstallation(sql);
    await postWebhook({
      installationId: seeded.installationId,
      event: "pull_request",
      body: pullRequestEvent({
        installationId: seeded.installationId,
        repoId: 20400,
        action: "opened",
        number: 11,
      }),
    });
    const res = await postWebhook({
      installationId: seeded.installationId,
      event: "pull_request",
      body: pullRequestEvent({
        installationId: seeded.installationId,
        repoId: 20400,
        action: "closed",
        number: 11,
        merged: false,
      }),
    });
    expect(res.status).toBe(200);
    const rows = await adminSql<{ state: string; merged_at: Date | null }[]>`
      SELECT state, merged_at FROM github_prs WHERE number = 11
    `;
    expect(rows[0]?.state).toBe("closed");
    expect(rows[0]?.merged_at).toBeNull();
  });

  it("installation.created syncs inline repositories", async () => {
    const seeded = await seedInstallation(sql);
    const res = await postWebhook({
      installationId: seeded.installationId,
      event: "installation",
      body: installationEvent({
        installationId: seeded.installationId,
        action: "created",
        repositories: [
          { id: 50001, name: "alpha", full_name: "org/alpha" },
          { id: 50002, name: "beta", full_name: "org/beta" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const rows = await adminSql<{ github_repo_id: string; name: string }[]>`
      SELECT github_repo_id::text, name FROM repos
      WHERE github_repo_id IN (50001, 50002)
      ORDER BY github_repo_id
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.name).toBe("org/alpha");
    expect(rows[1]?.name).toBe("org/beta");
  });

  it("installation.deleted marks status=deleted without cascading", async () => {
    const seeded = await seedInstallation(sql);
    // Populate some commits first via a push.
    await postWebhook({
      installationId: seeded.installationId,
      event: "push",
      body: pushEvent({
        installationId: seeded.installationId,
        repoId: 60101,
        commits: [
          {
            id: "6".repeat(40),
            message: "keep me",
            timestamp: "2026-04-07T10:00:00Z",
            author: { email: "c@x.com", name: "C" },
          },
        ],
      }),
    });
    // Now delete the installation.
    const res = await postWebhook({
      installationId: seeded.installationId,
      event: "installation",
      body: installationEvent({
        installationId: seeded.installationId,
        action: "deleted",
      }),
    });
    expect(res.status).toBe(200);
    const inst = await adminSql<{ status: string }[]>`
      SELECT status FROM github_installations WHERE installation_id = ${seeded.installationId}
    `;
    expect(inst[0]?.status).toBe("deleted");
    const commits = await adminSql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM github_commits WHERE sha = ${"6".repeat(40)}
    `;
    expect(Number(commits[0]?.count)).toBe(1);
  });

  it("installation_repositories.added upserts new repos", async () => {
    const seeded = await seedInstallation(sql);
    const res = await postWebhook({
      installationId: seeded.installationId,
      event: "installation_repositories",
      body: installationRepositoriesEvent({
        installationId: seeded.installationId,
        action: "added",
        added: [{ id: 70001, name: "gamma", full_name: "org/gamma", default_branch: "main" }],
      }),
    });
    expect(res.status).toBe(200);
    const rows = await adminSql<{ name: string }[]>`
      SELECT name FROM repos WHERE github_repo_id = 70001
    `;
    expect(rows[0]?.name).toBe("org/gamma");
  });

  it("installation_repositories.removed soft-deletes repos", async () => {
    const seeded = await seedInstallation(sql);
    await postWebhook({
      installationId: seeded.installationId,
      event: "installation_repositories",
      body: installationRepositoriesEvent({
        installationId: seeded.installationId,
        action: "added",
        added: [{ id: 80001, name: "delta", full_name: "org/delta" }],
      }),
    });
    const res = await postWebhook({
      installationId: seeded.installationId,
      event: "installation_repositories",
      body: installationRepositoriesEvent({
        installationId: seeded.installationId,
        action: "removed",
        removed: [{ id: 80001, name: "delta" }],
      }),
    });
    expect(res.status).toBe(200);
    const rows = await adminSql<{ archived_at: Date | null }[]>`
      SELECT archived_at FROM repos WHERE github_repo_id = 80001
    `;
    expect(rows[0]?.archived_at).not.toBeNull();
  });

  it("returns 400 when installation.id is missing from body", async () => {
    const bodyStr = JSON.stringify({ action: "opened", number: 1 });
    const res = await fetch(`${baseUrl}/v1/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": sign(bodyStr),
      },
      body: bodyStr,
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { code: string };
    expect(j.code).toBe("MISSING_INSTALLATION_ID");
  });

  it("returns 200 for ping event without installation", async () => {
    const bodyStr = JSON.stringify({});
    const res = await fetch(`${baseUrl}/v1/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": sign(bodyStr),
      },
      body: bodyStr,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; event: string };
    expect(j.ok).toBe(true);
    expect(j.event).toBe("ping");
  });

  it("push links commit to PR when head_sha matches", async () => {
    const seeded = await seedInstallation(sql);
    const sha = "9".repeat(40);
    // Open a PR with head_sha = sha.
    await postWebhook({
      installationId: seeded.installationId,
      event: "pull_request",
      body: pullRequestEvent({
        installationId: seeded.installationId,
        repoId: 30001,
        action: "opened",
        number: 101,
        headSha: sha,
      }),
    });
    // Push that commit.
    await postWebhook({
      installationId: seeded.installationId,
      event: "push",
      body: pushEvent({
        installationId: seeded.installationId,
        repoId: 30001,
        commits: [
          {
            id: sha,
            message: "pr commit",
            timestamp: "2026-04-08T00:00:00Z",
            author: { email: "h@x.com", name: "H" },
          },
        ],
      }),
    });
    const rows = await adminSql<{ pr_id: string | null }[]>`
      SELECT pr_id FROM github_commits WHERE sha = ${sha}
    `;
    expect(rows[0]?.pr_id).not.toBeNull();
  });
});

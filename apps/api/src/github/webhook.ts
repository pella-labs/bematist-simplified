import type { Sql } from "postgres";
import { handleInstallation, handleInstallationRepositories } from "./handlers/installation";
import { handlePullRequest } from "./handlers/pullRequest";
import { handlePush, type PushPayload } from "./handlers/push";
import { runPushAttribution } from "./handlers/pushAttribution";
import type { InstallationTokenCache } from "./install";
import { verifyGithubSignature } from "./verify";

export interface WebhookRouteDeps {
  /**
   * Tenant-scoped Sql. Used for everything after the installation has been
   * resolved (push/PR handlers set `app.current_org_id` before writes).
   */
  sql: Sql;
  /**
   * Admin Sql used for the two cross-tenant reads the webhook receiver
   * cannot avoid: the `github_installations` lookup (the tenant IS the
   * lookup target) and the `webhook_deliveries` dedup insert
   * (`webhook_deliveries` has no `org_id`). Falls back to `sql` when
   * unset — only safe if `sql` connects as a BYPASSRLS role.
   */
  adminSql?: Sql;
  webhookSecret: string;
  tokenCache?: InstallationTokenCache;
  githubAppId?: string | number;
  githubAppPrivateKey?: string;
  fetchFn?: typeof fetch;
  apiBase?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function githubWebhookRoute(req: Request, deps: WebhookRouteDeps): Promise<Response> {
  const rawBody = new Uint8Array(await req.arrayBuffer());
  const signature = req.headers.get("x-hub-signature-256");
  const event = req.headers.get("x-github-event") ?? "";
  const deliveryId = req.headers.get("x-github-delivery") ?? "";

  const verify = verifyGithubSignature({
    rawBody,
    signatureHeader: signature,
    activeSecret: deps.webhookSecret,
  });
  if (!verify.ok) {
    return json({ error: "invalid signature", code: "BAD_SIGNATURE", reason: verify.reason }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const installationFromBody = (body as { installation?: { id?: unknown } })?.installation?.id;
  const installationId =
    typeof installationFromBody === "number" &&
    Number.isFinite(installationFromBody) &&
    installationFromBody > 0
      ? installationFromBody
      : null;
  if (installationId === null) {
    // `ping` event from GitHub when webhook URL is first saved — no installation context, just ack.
    if (event === "ping") return json({ ok: true, event: "ping" });
    return json({ error: "missing installation.id in body", code: "MISSING_INSTALLATION_ID" }, 400);
  }

  const adminSql = deps.adminSql ?? deps.sql;

  // Transport dedup. `webhook_deliveries` has no `org_id` column and is
  // therefore not RLS-scoped — admin or app role both write, but we route
  // through the admin handle for symmetry with the installation lookup.
  if (deliveryId.length > 0) {
    const dedup = await adminSql<{ delivery_id: string }[]>`
      INSERT INTO webhook_deliveries (delivery_id, installation_id)
      VALUES (${deliveryId}, ${installationId})
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING delivery_id
    `;
    if (dedup.length === 0) {
      return json({ ok: true, deduped: true });
    }
  }

  // Resolve org_id from installation_id. The installation IS the tenant
  // lookup so it cannot itself assume a tenant — this must hit an admin
  // role that bypasses RLS. In dev/test the admin role IS the superuser
  // used to migrate; in prod set ADMIN_DATABASE_URL to a BYPASSRLS role.
  let orgId: string | null = null;
  if (event !== "installation") {
    const rows = await adminSql<{ org_id: string; status: string }[]>`
      SELECT org_id, status FROM github_installations
      WHERE installation_id = ${installationId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return json({ error: "unknown installation", code: "UNKNOWN_INSTALLATION" }, 404);
    }
    if (row.status !== "active") {
      return json({ error: `installation ${row.status}`, code: "INSTALLATION_NOT_ACTIVE" }, 404);
    }
    orgId = row.org_id;
  } else {
    // For installation.created we may not have a row yet. The admin UI
    // flow writes the row before redirecting back from GitHub so by the
    // time the webhook arrives the row exists; on mis-ordering we log
    // and no-op.
    const rows = await adminSql<{ org_id: string }[]>`
      SELECT org_id FROM github_installations
      WHERE installation_id = ${installationId}
      LIMIT 1
    `;
    orgId = rows[0]?.org_id ?? null;
  }

  try {
    await dispatch(event, body, installationId, orgId, deps);
  } catch (err) {
    console.error("[github-webhook] dispatch error", {
      event,
      deliveryId,
      installationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "processing error", code: "PROCESSING_ERROR" }, 500);
  }

  return json({ ok: true, event });
}

async function dispatch(
  event: string,
  body: unknown,
  installationId: number,
  orgId: string | null,
  deps: WebhookRouteDeps,
): Promise<void> {
  if (event === "installation") {
    if (!orgId) {
      // Accept-and-log: if we have no prior install row the admin flow hasn't
      // completed yet. We'd need a setup_action=install OAuth round-trip to
      // resolve the org — leave this as a no-op rather than silently
      // dropping into an unknown tenant.
      console.warn("[github-webhook] installation event with no pre-existing org mapping", {
        installationId,
      });
      return;
    }
    await handleInstallation(body as never, {
      sql: deps.sql,
      orgId,
      tokenCache: deps.tokenCache,
      githubAppId: deps.githubAppId,
      githubAppPrivateKey: deps.githubAppPrivateKey,
      fetchFn: deps.fetchFn,
      apiBase: deps.apiBase,
    });
    return;
  }

  if (!orgId) return;

  if (event === "installation_repositories") {
    await handleInstallationRepositories(body as never, { sql: deps.sql, orgId });
    return;
  }
  if (event === "push") {
    const payload = body as PushPayload;
    await handlePush(payload, { sql: deps.sql, orgId });
    await runPushAttribution(payload, { sql: deps.sql, orgId });
    return;
  }
  if (event === "pull_request") {
    await handlePullRequest(body as never, { sql: deps.sql, orgId });
    return;
  }
  // Unknown events are accepted (to keep GitHub retries from firing) but
  // unhandled.
}

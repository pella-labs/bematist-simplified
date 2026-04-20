import { listSubscriptions } from "@bematist/embed";
import { brand } from "@bematist/ui/brand";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatUsd } from "@/components/dashboard/format";
import { listDevelopers, listUsers } from "@/components/dashboard/queries";
import { requireSession } from "@/lib/session";
import { DeveloperTierForm } from "./DeveloperTierForm";
import "../../(dashboard)/dashboard.css";
import "../../(marketing)/marketing.css";

export const metadata: Metadata = {
  title: `Admin · Developers — ${brand.name}`,
};

interface PageProps {
  searchParams: Promise<{ status?: string; message?: string }>;
}

export default async function AdminDevelopersPage({ searchParams }: PageProps) {
  const session = await requireSession();
  if (session.role !== "admin") {
    redirect("/me?forbidden=admin-only");
  }
  const sp = await searchParams;

  const [devs, users] = await Promise.all([
    listDevelopers(session.org.id),
    listUsers(session.org.id),
  ]);

  const subs = listSubscriptions();
  const byProvider: Record<"claude" | "codex" | "cursor", Array<{ id: string; label: string }>> = {
    claude: [],
    codex: [],
    cursor: [],
  };
  for (const [id, row] of Object.entries(subs)) {
    if (row.provider === "anthropic") {
      byProvider.claude.push({ id, label: `${id} · ${formatUsd(row.monthly_usd)}/mo` });
    } else if (row.provider === "openai") {
      byProvider.codex.push({ id, label: `${id} · ${formatUsd(row.monthly_usd)}/mo` });
    } else if (row.provider === "cursor") {
      byProvider.cursor.push({ id, label: `${id} · ${formatUsd(row.monthly_usd)}/mo` });
    }
  }

  return (
    <div className="bematist-marketing">
      <div className="dash-shell" style={{ gridTemplateColumns: "1fr" }}>
        <main className="dash-main">
          <header className="dash-page-head">
            <span className="mk-sys">Admin · Developers</span>
            <h1 className="dash-page-title">Developer administration</h1>
            <p className="dash-page-subtitle">
              Override subscription tiers, revoke ingest keys, and review signed-in users. All
              changes scoped to {session.org.name}.
            </p>
            <div className="dash-page-actions">
              <Link href="/developers" className="dash-btn">
                Back to developer view
              </Link>
              <Link href="/admin/keys" className="dash-btn">
                Ingest keys
              </Link>
              <Link href="/admin/github" className="dash-btn">
                GitHub app
              </Link>
            </div>
          </header>

          {sp.status ? (
            <div className={`dash-banner ${sp.status === "ok" ? "is-ok" : "is-warn"}`}>
              {sp.message ?? (sp.status === "ok" ? "Change saved." : "Change failed.")}
            </div>
          ) : null}

          <section>
            <div className="dash-card">
              <div className="dash-card-head">
                <h2 className="dash-card-title">Developers ({devs.length})</h2>
              </div>
              <table className="dash-table">
                <thead>
                  <tr>
                    <th>Developer</th>
                    <th>Linked user</th>
                    <th>Subscriptions</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {devs.map((d) => {
                    const linkedUser = d.userId ? users.find((u) => u.id === d.userId) : undefined;
                    return (
                      <tr key={d.id}>
                        <td>
                          <Link href={`/developers/${d.id}`} className="dash-table-link">
                            {d.name ?? d.email}
                          </Link>
                          <div
                            className="dash-mono"
                            style={{ fontSize: 11, color: "var(--mk-ink-muted)" }}
                          >
                            {d.email}
                          </div>
                        </td>
                        <td
                          className="dash-mono"
                          style={{ fontSize: 12, color: "var(--mk-ink-muted)" }}
                        >
                          {linkedUser ? `${linkedUser.role} · ${linkedUser.email}` : "—"}
                        </td>
                        <td>
                          <DeveloperTierForm
                            developerId={d.id}
                            current={{
                              claude: d.subscriptionClaude,
                              codex: d.subscriptionCodex,
                              cursor: d.subscriptionCursor,
                            }}
                            options={byProvider}
                          />
                        </td>
                        <td>
                          <DeveloperTierForm.Revoker developerId={d.id} />
                        </td>
                      </tr>
                    );
                  })}
                  {devs.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ padding: 24 }}>
                        <div
                          className="dash-mono"
                          style={{ color: "var(--mk-ink-muted)", fontSize: 12 }}
                        >
                          No developers yet. Create an ingest key to register one.
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <div className="dash-card">
              <div className="dash-card-head">
                <h2 className="dash-card-title">Signed-in users ({users.length})</h2>
                <span className="dash-card-sub">Invite new teammates via sign-in link</span>
              </div>
              <table className="dash-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Email</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>{u.name ?? u.email}</td>
                      <td>
                        <span className={`dash-chip ${u.role === "admin" ? "is-accent" : ""}`}>
                          {u.role}
                        </span>
                      </td>
                      <td
                        className="dash-mono"
                        style={{ fontSize: 12, color: "var(--mk-ink-muted)" }}
                      >
                        {u.email}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

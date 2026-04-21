import { brand } from "@bematist/ui/brand";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatRelative } from "@/components/dashboard/format";
import { listIngestKeys } from "@/components/dashboard/queries";
import { requireSession } from "@/lib/session";
import { KeyActions, MintKeyForm } from "./KeyClient";
import "../../(dashboard)/dashboard.css";
import "../../(marketing)/marketing.css";

export const metadata: Metadata = {
  title: `Admin · Ingest keys — ${brand.name}`,
};

export default async function AdminKeysPage() {
  const session = await requireSession();
  if (session.role !== "admin") {
    redirect("/me?forbidden=admin-only");
  }
  const keys = await listIngestKeys(session.org.id);

  return (
    <div className="bematist-marketing">
      <div className="dash-shell" style={{ gridTemplateColumns: "1fr" }}>
        <main className="dash-main">
          <header className="dash-page-head">
            <span className="mk-sys">Admin · Ingest keys</span>
            <h1 className="dash-page-title">Ingest keys</h1>
            <p className="dash-page-subtitle">
              Create a key per developer. Paste the plaintext into{" "}
              <code className="dash-mono">bm-pilot login</code> once; we only store the SHA256 so
              you cannot retrieve it later.
            </p>
            <div className="dash-page-actions">
              <Link href="/admin/developers" className="dash-btn">
                Developers
              </Link>
              <Link href="/admin/github" className="dash-btn">
                GitHub app
              </Link>
            </div>
          </header>

          <section>
            <div className="dash-card">
              <div className="dash-card-head">
                <h2 className="dash-card-title">Create a key</h2>
                <span className="dash-card-sub">One per developer machine</span>
              </div>
              <div style={{ padding: 20 }}>
                <MintKeyForm />
              </div>
            </div>
          </section>

          <section>
            <div className="dash-card">
              <div className="dash-card-head">
                <h2 className="dash-card-title">Existing keys ({keys.length})</h2>
              </div>
              {keys.length === 0 ? (
                <div style={{ padding: 20 }}>
                  <div className="dash-empty">
                    <h3 className="dash-empty-title">No keys issued yet</h3>
                    <p className="dash-empty-body">
                      Create one above — the developer uses it with{" "}
                      <code>bm-pilot login --key &lt;…&gt;</code>.
                    </p>
                  </div>
                </div>
              ) : (
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>Key id</th>
                      <th>Developer</th>
                      <th>Created</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((k) => (
                      <tr key={k.id}>
                        <td className="dash-mono">{k.id}</td>
                        <td>
                          <div>{k.developerName ?? k.developerEmail}</div>
                          <div
                            className="dash-mono"
                            style={{ fontSize: 11, color: "var(--mk-ink-muted)" }}
                          >
                            {k.developerEmail}
                          </div>
                        </td>
                        <td
                          className="dash-mono"
                          style={{ fontSize: 12, color: "var(--mk-ink-muted)" }}
                        >
                          {formatRelative(k.createdAt)}
                        </td>
                        <td>
                          {k.revokedAt ? (
                            <span className="dash-chip is-warm">Revoked</span>
                          ) : (
                            <span className="dash-chip is-accent">Active</span>
                          )}
                        </td>
                        <td>{!k.revokedAt ? <KeyActions keyId={k.id} /> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

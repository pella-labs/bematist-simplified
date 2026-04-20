import { githubInstallations, repos } from "@bematist/db/schema";
import { brand } from "@bematist/ui/brand";
import { desc, sql as dsql, eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession, withOrgScope } from "@/lib/session";
import "../../(marketing)/marketing.css";
import "./admin.css";

export const metadata: Metadata = {
  title: `GitHub — ${brand.name}`,
  description: "Connect your GitHub App installation.",
};

interface PageProps {
  searchParams: Promise<{ status?: string; message?: string }>;
}

interface InstalledRepo {
  id: string;
  name: string;
  defaultBranch: string | null;
  installationId: string;
  archivedAt: Date | null;
}

interface InstallationView {
  id: string;
  installationId: string;
  status: string;
  createdAt: Date;
  repoCount: number;
}

async function loadInstallations(orgId: string): Promise<{
  installations: InstallationView[];
  repos: InstalledRepo[];
}> {
  return withOrgScope(orgId, async (tx) => {
    const installRows = await tx
      .select({
        id: githubInstallations.id,
        installationId: githubInstallations.installationId,
        status: githubInstallations.status,
        createdAt: githubInstallations.createdAt,
      })
      .from(githubInstallations)
      .where(eq(githubInstallations.orgId, orgId))
      .orderBy(desc(githubInstallations.createdAt));

    const repoRows = await tx
      .select({
        id: repos.id,
        name: repos.name,
        defaultBranch: repos.defaultBranch,
        installationId: repos.installationId,
        archivedAt: repos.archivedAt,
      })
      .from(repos)
      .where(eq(repos.orgId, orgId))
      .orderBy(dsql`${repos.archivedAt} nulls first`, repos.name);

    const repoCountByInstall = new Map<string, number>();
    for (const r of repoRows) {
      if (r.archivedAt) continue;
      const key = String(r.installationId);
      repoCountByInstall.set(key, (repoCountByInstall.get(key) ?? 0) + 1);
    }

    return {
      installations: installRows.map((i) => ({
        id: String(i.id),
        installationId: String(i.installationId),
        status: i.status,
        createdAt: i.createdAt,
        repoCount: repoCountByInstall.get(String(i.installationId)) ?? 0,
      })),
      repos: repoRows.map((r) => ({
        id: r.id,
        name: r.name,
        defaultBranch: r.defaultBranch,
        installationId: String(r.installationId),
        archivedAt: r.archivedAt,
      })),
    };
  });
}

function resolveInstallUrl(): string | null {
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug) return null;
  return `https://github.com/apps/${slug}/installations/new`;
}

export default async function AdminGithubPage({ searchParams }: PageProps) {
  const session = await requireSession();
  if (session.role !== "admin") {
    redirect("/?forbidden=admin-only");
  }
  const sp = await searchParams;
  const data = await loadInstallations(session.org.id);
  const installUrl = resolveInstallUrl();

  return (
    <div className="bematist-marketing">
      <div className="mk-container admin-container">
        <header className="admin-nav">
          <Link href="/" className="mk-wordmark" aria-label={`${brand.name} home`}>
            <span className="mk-wordmark-dot" aria-hidden />
            {brand.wordmark}
          </Link>
          <nav className="admin-nav-links">
            <span className="mk-sys">{session.org.name}</span>
            <span className="admin-role-badge">admin</span>
          </nav>
        </header>

        <main className="admin-main">
          <div className="admin-heading">
            <span className="mk-sys">GitHub App</span>
            <h1 className="admin-title">Connect repositories</h1>
            <p className="admin-subtitle">
              Install the Bematist GitHub App so we can receive push and pull-request webhooks and
              link commits back to the sessions that produced them.
            </p>
          </div>

          {sp.status ? (
            <div
              className={`admin-banner admin-banner-${sp.status === "ok" ? "ok" : "warn"}`}
              role={sp.status === "ok" ? "status" : "alert"}
            >
              {sp.message ?? (sp.status === "ok" ? "Installation saved." : "Install failed.")}
            </div>
          ) : null}

          <section className="admin-section">
            <div className="admin-section-head">
              <h2 className="admin-section-title">Installations</h2>
              {installUrl ? (
                <Link href={installUrl} className="admin-cta-primary">
                  <span className="admin-cta-dot" aria-hidden />
                  Connect GitHub
                </Link>
              ) : (
                <span className="admin-cta-disabled" title="GITHUB_APP_SLUG env var missing">
                  Install URL unavailable
                </span>
              )}
            </div>

            {data.installations.length === 0 ? (
              <div className="admin-empty">
                <p className="admin-empty-title">No installations yet.</p>
                <p className="admin-empty-body">
                  Click <strong>Connect GitHub</strong> above to add your team&apos;s repositories.
                </p>
              </div>
            ) : (
              <ul className="admin-install-list">
                {data.installations.map((inst) => (
                  <li key={inst.id} className="admin-install-row">
                    <div className="admin-install-id">
                      <span className="mk-sys">Installation</span>
                      <span className="mk-mono admin-install-id-value">#{inst.installationId}</span>
                    </div>
                    <div className="admin-install-status">
                      <span className={`admin-status admin-status-${inst.status}`}>
                        {inst.status}
                      </span>
                      <span className="mk-muted">
                        {inst.repoCount} repo{inst.repoCount === 1 ? "" : "s"}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="admin-section">
            <h2 className="admin-section-title">Tracked repositories</h2>
            {data.repos.length === 0 ? (
              <div className="admin-empty">
                <p className="admin-empty-body">
                  No repositories synced yet. Repositories appear here after the GitHub App
                  installation completes.
                </p>
              </div>
            ) : (
              <ul className="admin-repo-list">
                {data.repos.map((r) => (
                  <li key={r.id} className="admin-repo-row">
                    <div className="admin-repo-name">
                      <span className="mk-mono">{r.name}</span>
                      {r.defaultBranch ? (
                        <span className="admin-repo-branch">{r.defaultBranch}</span>
                      ) : null}
                    </div>
                    <div className="admin-repo-state">
                      {r.archivedAt ? (
                        <span className="admin-chip admin-chip-muted">untracked</span>
                      ) : (
                        <span className="admin-chip admin-chip-accent">tracked</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="admin-help mk-muted">
              Tracking follows the GitHub App&apos;s repo selection. Add or remove repositories from
              your organisation&apos;s GitHub App settings; changes sync via webhooks.
            </p>
          </section>
        </main>
      </div>
    </div>
  );
}

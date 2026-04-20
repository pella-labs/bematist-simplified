import { brand } from "@bematist/ui/brand";
import type { Metadata } from "next";
import { NoSessionsEmpty } from "@/components/dashboard/EmptyState";
import { listDevelopers, listSessions } from "@/components/dashboard/queries";
import { SessionFilterBar } from "@/components/dashboard/SessionFilterBar";
import { SessionRow, SessionTableHeader } from "@/components/dashboard/SessionRow";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = {
  title: `Sessions — ${brand.name}`,
  description: "Per-developer AI-coding sessions across Claude Code, Codex, and Cursor.",
};

interface PageProps {
  searchParams: Promise<{ developer?: string; source?: string }>;
}

type Source = "claude-code" | "codex" | "cursor";

function normalizeSource(raw: string | undefined): Source | undefined {
  if (raw === "claude-code" || raw === "codex" || raw === "cursor") return raw;
  return undefined;
}

export default async function SessionsListPage({ searchParams }: PageProps) {
  const session = await requireSession();
  const sp = await searchParams;
  const devs = await listDevelopers(session.org.id);
  const developerId =
    sp.developer && devs.find((d) => d.id === sp.developer) ? sp.developer : undefined;
  const source = normalizeSource(sp.source);

  const filters: { developerId?: string; source?: Source; limit: number } = { limit: 100 };
  if (developerId) filters.developerId = developerId;
  if (source) filters.source = source;
  const rows = await listSessions(session.org.id, filters);

  return (
    <>
      <header className="dash-page-head">
        <span className="mk-sys">Sessions</span>
        <h1 className="dash-page-title">Session feed</h1>
        <p className="dash-page-subtitle">
          Every AI-coding session captured across Claude Code, Codex, and Cursor. Click a row for
          the full transcript, token breakdown, and any commits attributed to the session.
        </p>
      </header>

      <SessionFilterBar
        developers={devs.map((d) => ({ id: d.id, label: d.name ?? d.email }))}
        selectedDeveloperId={developerId ?? ""}
        selectedSource={source ?? ""}
      />

      <section>
        <div className="dash-card">
          <div className="dash-card-head">
            <h2 className="dash-card-title">
              {developerId || source ? "Filtered sessions" : "All sessions"}
            </h2>
            <span className="dash-card-sub">{rows.length} matches</span>
          </div>
          {rows.length === 0 ? (
            <div style={{ padding: 24 }}>
              <NoSessionsEmpty />
            </div>
          ) : (
            <table className="dash-table">
              <SessionTableHeader />
              <tbody>
                {rows.map((s) => (
                  <SessionRow key={s.id} session={s} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}

import { brand } from "@bematist/ui/brand";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DeveloperCard } from "@/components/dashboard/DeveloperCard";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { listDevelopers } from "@/components/dashboard/queries";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = {
  title: `Developers — ${brand.name}`,
};

export default async function DevelopersListPage() {
  const session = await requireSession();
  if (session.role !== "admin") {
    redirect("/me?forbidden=admin-only");
  }
  const devs = await listDevelopers(session.org.id);

  return (
    <>
      <header className="dash-page-head">
        <span className="mk-sys">Developers</span>
        <h1 className="dash-page-title">Your team</h1>
        <p className="dash-page-subtitle">
          One card per developer emitting telemetry. Click through for session history, cost
          breakdown, and outcome attribution.
        </p>
      </header>

      {devs.length === 0 ? (
        <EmptyState
          title="No developers yet"
          body={
            <>
              Developers appear here once their ingest key starts sending events. Create one in{" "}
              <a href="/admin/keys" className="dash-mono" style={{ color: "var(--mk-accent)" }}>
                admin · ingest keys
              </a>
              .
            </>
          }
        />
      ) : (
        <div className="dash-devcard-grid">
          {devs.map((d, i) => (
            <DeveloperCard key={d.id} developer={d} index={i} href={`/developers/${d.id}`} />
          ))}
        </div>
      )}
    </>
  );
}

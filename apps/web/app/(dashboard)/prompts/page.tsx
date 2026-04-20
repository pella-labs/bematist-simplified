import { brand } from "@bematist/ui/brand";
import type { Metadata } from "next";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { formatInt, formatUsd, truncateMiddle } from "@/components/dashboard/format";
import { listPromptClusters } from "@/components/dashboard/queries";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = {
  title: `Prompt clusters — ${brand.name}`,
};

export default async function PromptsPage() {
  const session = await requireSession();
  const clusters = await listPromptClusters(session.org.id);

  const labeled = clusters.filter((c) => c.clusterId !== null);
  const unclustered = clusters.find((c) => c.clusterId === null);

  return (
    <>
      <header className="dash-page-head">
        <span className="mk-sys">Prompts</span>
        <h1 className="dash-page-title">Prompt clusters</h1>
        <p className="dash-page-subtitle">
          Every captured prompt is embedded with MiniLM and clustered nightly. Each row shows one
          cluster with its size, merge rate, and an example prompt from the cluster.
        </p>
      </header>

      {clusters.length === 0 ? (
        <EmptyState
          title="No prompts yet"
          body="Clusters appear once the embedding worker catches up with your first prompts. This usually takes under a minute after the first sessions stream in."
        />
      ) : (
        <section>
          <div className="dash-card">
            <div className="dash-card-head">
              <h2 className="dash-card-title">Clusters</h2>
              <span className="dash-card-sub">
                {labeled.length} clustered ·{" "}
                {unclustered ? `${formatInt(unclustered.promptCount)} pending` : "0 pending"}
              </span>
            </div>
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Cluster</th>
                  <th className="num">Prompts</th>
                  <th className="num">Sessions</th>
                  <th className="num">With merged PRs</th>
                  <th className="num">Avg cost</th>
                  <th>Example</th>
                </tr>
              </thead>
              <tbody>
                {labeled.map((c) => (
                  <tr key={c.clusterId ?? "none"}>
                    <td className="dash-mono">
                      {c.label ?? (c.clusterId ? c.clusterId.slice(0, 8) : "—")}
                    </td>
                    <td className="num">{formatInt(c.promptCount)}</td>
                    <td className="num">{formatInt(c.sessionCount)}</td>
                    <td className="num">
                      {formatInt(c.mergedSessionCount)}
                      {c.sessionCount > 0 ? (
                        <span
                          className="dash-mono"
                          style={{ color: "var(--mk-ink-muted)", marginLeft: 6, fontSize: 11 }}
                        >
                          {Math.round((c.mergedSessionCount / c.sessionCount) * 100)}%
                        </span>
                      ) : null}
                    </td>
                    <td className="num">{formatUsd(c.avgCostUsd, 4)}</td>
                    <td style={{ color: "var(--mk-ink-muted)", maxWidth: 360 }}>
                      {c.exampleText ? truncateMiddle(c.exampleText, 120) : "—"}
                    </td>
                  </tr>
                ))}
                {unclustered && unclustered.promptCount > 0 ? (
                  <tr>
                    <td className="dash-mono" style={{ color: "var(--mk-ink-faint)" }}>
                      Unclustered
                    </td>
                    <td className="num">{formatInt(unclustered.promptCount)}</td>
                    <td className="num">{formatInt(unclustered.sessionCount)}</td>
                    <td className="num">—</td>
                    <td className="num">—</td>
                    <td style={{ color: "var(--mk-ink-muted)" }}>
                      {unclustered.exampleText
                        ? truncateMiddle(unclustered.exampleText, 120)
                        : "Pending next recluster"}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

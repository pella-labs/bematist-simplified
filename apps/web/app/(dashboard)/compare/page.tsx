import { brand } from "@bematist/ui/brand";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { formatInt, formatTokens, formatUsd } from "@/components/dashboard/format";
import {
  type CompareItem,
  getCompareItem,
  listPromptClusters,
  listSessions,
} from "@/components/dashboard/queries";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = {
  title: `Compare — ${brand.name}`,
};

interface PageProps {
  searchParams: Promise<{ a?: string; b?: string; at?: string; bt?: string }>;
}

type SlotKind = "session" | "cluster";

function parseKind(raw: string | undefined): SlotKind {
  return raw === "cluster" ? "cluster" : "session";
}

function ComparePane({ label, item }: { label: string; item: CompareItem | null }) {
  if (!item) {
    return (
      <div className="dash-tile">
        <span className="dash-tile-label">{label}</span>
        <span className="dash-tile-value" style={{ fontSize: 18, color: "var(--mk-ink-muted)" }}>
          Nothing selected
        </span>
        <span className="dash-tile-sub">
          Pick a session or cluster from the form below to compare.
        </span>
      </div>
    );
  }
  return (
    <div className="dash-tile">
      <span className="dash-tile-label">
        {label} · {item.kind}
      </span>
      <span className="dash-tile-value" style={{ fontSize: 20 }}>
        {item.label}
      </span>
      {item.subtitle ? <span className="dash-tile-sub">{item.subtitle}</span> : null}
      <dl className="dash-kvs" style={{ marginTop: 14 }}>
        <dt>Cost</dt>
        <dd className="dash-mono">{formatUsd(item.costUsd, 4)}</dd>
        {item.kind === "session" ? (
          <>
            <dt>Tokens in</dt>
            <dd className="dash-mono">{formatTokens(item.tokensInput)}</dd>
            <dt>Tokens out</dt>
            <dd className="dash-mono">{formatTokens(item.tokensOutput)}</dd>
          </>
        ) : null}
        <dt>{item.kind === "cluster" ? "Prompts" : "Events"}</dt>
        <dd className="dash-mono">{formatInt(item.eventCount)}</dd>
        <dt>Cluster</dt>
        <dd className="dash-mono">{item.clusterId ? item.clusterId.slice(0, 12) : "—"}</dd>
        <dt>Merged commits</dt>
        <dd className="dash-mono">{formatInt(item.mergedCommitCount)}</dd>
      </dl>
    </div>
  );
}

export default async function ComparePage({ searchParams }: PageProps) {
  const session = await requireSession();
  const sp = await searchParams;

  const kindA = parseKind(sp.at);
  const kindB = parseKind(sp.bt);
  const aId = sp.a ?? "";
  const bId = sp.b ?? "";

  const [itemA, itemB, sessions, clusters] = await Promise.all([
    aId ? getCompareItem(session.org.id, kindA, aId) : Promise.resolve(null),
    bId ? getCompareItem(session.org.id, kindB, bId) : Promise.resolve(null),
    listSessions(session.org.id, { limit: 100 }),
    listPromptClusters(session.org.id),
  ]);

  const options = [
    ...sessions.map((s) => ({
      kind: "session" as const,
      id: s.id,
      label: `${s.developerName ?? s.developerEmail} · ${s.source} · ${s.startedAt
        .toISOString()
        .slice(0, 16)
        .replace("T", " ")}`,
    })),
    ...clusters
      .filter((c) => c.clusterId !== null)
      .map((c) => ({
        kind: "cluster" as const,
        id: c.clusterId!,
        label: `cluster · ${c.label ?? c.clusterId!.slice(0, 8)} · ${c.promptCount} prompts`,
      })),
  ];

  if (options.length === 0) {
    return (
      <>
        <header className="dash-page-head">
          <span className="mk-sys">Compare</span>
          <h1 className="dash-page-title">Side by side</h1>
        </header>
        <EmptyState
          title="Nothing to compare yet"
          body="Capture at least two sessions to use the compare view."
        />
      </>
    );
  }

  return (
    <>
      <header className="dash-page-head">
        <span className="mk-sys">Compare</span>
        <h1 className="dash-page-title">Side by side</h1>
        <p className="dash-page-subtitle">
          Pick any two sessions or clusters to compare tokens, cost, cluster similarity, and
          merged-commit counts.
        </p>
      </header>

      <form method="get" className="dash-filter-bar" style={{ flexWrap: "wrap" }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="dash-filter-label">Slot A</span>
          <select
            name="a"
            defaultValue={aId}
            className="dash-filter-select"
            aria-label="Slot A selection"
          >
            <option value="">Select…</option>
            {options.map((o) => (
              <option key={`a-${o.kind}-${o.id}`} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            type="hidden"
            name="at"
            value={options.find((o) => o.id === aId)?.kind ?? "session"}
          />
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="dash-filter-label">Slot B</span>
          <select
            name="b"
            defaultValue={bId}
            className="dash-filter-select"
            aria-label="Slot B selection"
          >
            <option value="">Select…</option>
            {options.map((o) => (
              <option key={`b-${o.kind}-${o.id}`} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            type="hidden"
            name="bt"
            value={options.find((o) => o.id === bId)?.kind ?? "session"}
          />
        </label>
        <button type="submit" className="dash-btn is-primary">
          Compare
        </button>
        {(aId || bId) && (
          <Link href="/compare" className="dash-btn">
            Clear
          </Link>
        )}
      </form>

      <section className="dash-compare-grid">
        <ComparePane label="Slot A" item={itemA} />
        <ComparePane label="Slot B" item={itemB} />
      </section>

      {itemA && itemB && itemA.clusterId && itemB.clusterId ? (
        <section>
          <div
            className={`dash-banner ${itemA.clusterId === itemB.clusterId ? "is-ok" : "is-warn"}`}
          >
            {itemA.clusterId === itemB.clusterId
              ? "Both sides share the same prompt cluster — similar intent."
              : "Different prompt clusters — distinct intents."}
          </div>
        </section>
      ) : null}
    </>
  );
}

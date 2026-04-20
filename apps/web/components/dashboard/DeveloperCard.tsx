"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { formatInt, formatUsd } from "./format";
import type { DeveloperSummary } from "./queries";

export function DeveloperCard({
  developer,
  index = 0,
  href,
}: {
  developer: DeveloperSummary;
  index?: number;
  href: string;
}) {
  const tiers = [
    { label: "Claude", value: developer.subscriptionClaude },
    { label: "Codex", value: developer.subscriptionCodex },
    { label: "Cursor", value: developer.subscriptionCursor },
  ].filter((t) => t.value);
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: "easeOut", delay: Math.min(index * 0.03, 0.15) }}
    >
      <Link href={href} className="dash-devcard">
        <span className="dash-devcard-name">{developer.name ?? developer.email}</span>
        <span className="dash-devcard-email">{developer.email}</span>
        <div className="dash-devcard-stats">
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span className="dash-devcard-stat-val">{formatUsd(developer.monthlyCostUsd)}</span>
            <span className="dash-devcard-stat-lbl">This month</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span className="dash-devcard-stat-val">{formatInt(developer.sessionCount)}</span>
            <span className="dash-devcard-stat-lbl">Sessions</span>
          </div>
        </div>
        {tiers.length > 0 ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
            {tiers.map((t) => (
              <span key={t.label} className="dash-chip">
                {t.label}: {t.value}
              </span>
            ))}
          </div>
        ) : null}
      </Link>
    </motion.div>
  );
}

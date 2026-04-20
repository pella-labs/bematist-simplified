"use client";

import { motion } from "motion/react";
import { formatSignedUsd, formatUsd } from "./format";

export interface CostDeltaTileProps {
  actualUsd: number;
  subscriptionUsd: number;
  deltaUsd: number;
  month: string;
  subjectLabel?: string;
}

export function CostDeltaTile({
  actualUsd,
  subscriptionUsd,
  deltaUsd,
  month,
  subjectLabel = "Team",
}: CostDeltaTileProps) {
  const positive = deltaUsd > 0;
  const summary =
    subscriptionUsd <= 0 && actualUsd <= 0
      ? "No usage yet this month"
      : positive
        ? "Subscription is a bargain — API-equivalent bill would be higher."
        : deltaUsd === 0
          ? "API and subscription spend are even."
          : "Subscription covers more than API-equivalent usage — over-provisioned.";
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: "easeOut" }}
      className="dash-tile is-feature"
      style={{ gridColumn: "1 / -1", minHeight: 180 }}
    >
      <span className="dash-tile-label">
        Subscription vs API delta · {subjectLabel} · {month}
      </span>
      <div className="dash-delta">
        <span
          className={`dash-delta-value ${positive ? "dash-delta-positive" : "dash-delta-negative"}`}
        >
          {formatSignedUsd(deltaUsd)}
        </span>
        <span className="dash-delta-breakdown">
          API-equivalent {formatUsd(actualUsd)} · subscription {formatUsd(subscriptionUsd)}
        </span>
      </div>
      <span className="dash-tile-sub" style={{ marginTop: 2 }}>
        {summary}
      </span>
    </motion.div>
  );
}

"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

export interface StatTileProps {
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  feature?: boolean;
  index?: number;
}

export function StatTile({ label, value, caption, feature = false, index = 0 }: StatTileProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: "easeOut", delay: Math.min(index * 0.04, 0.2) }}
      className={`dash-tile${feature ? " is-feature" : ""}`}
    >
      <span className="dash-tile-label">{label}</span>
      <span className="dash-tile-value">{value}</span>
      {caption ? <span className="dash-tile-sub">{caption}</span> : null}
    </motion.div>
  );
}

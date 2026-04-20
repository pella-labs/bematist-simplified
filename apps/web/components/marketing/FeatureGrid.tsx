"use client";

import { brand } from "@bematist/ui/brand";
import { motion } from "motion/react";

export function FeatureGrid() {
  return (
    <section aria-labelledby="features-heading">
      <div className="mk-section-header">
        <span id="features-heading" className="mk-mono mk-xs mk-muted">
          01 / What Bematist shows you
        </span>
      </div>
      <div className="mk-features">
        {brand.features.map((f, i) => (
          <motion.div
            key={f.title}
            className="mk-feature"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.4, ease: "easeOut", delay: i * 0.08 }}
          >
            <span className="mk-feature-index">{f.eyebrow}</span>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

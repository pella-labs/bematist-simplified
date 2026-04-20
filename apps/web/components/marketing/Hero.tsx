"use client";

import { brand } from "@bematist/ui/brand";
import { motion } from "motion/react";
import Link from "next/link";

export function Hero() {
  return (
    <section className="mk-hero" aria-labelledby="hero-title">
      <div className="mk-hero-grid-lines" aria-hidden />
      <div className="mk-hero-backdrop" aria-hidden />
      <div className="mk-hero-content">
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
          className="mk-sys"
          style={{ marginBottom: 20 }}
        >
          per-developer AI-coding telemetry
        </motion.div>
        <motion.h1
          id="hero-title"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut", delay: 0.05 }}
        >
          Measure which <em>prompts</em> actually ship.
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut", delay: 0.15 }}
        >
          {brand.subtitle}
        </motion.p>
        <motion.div
          className="mk-hero-actions"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut", delay: 0.25 }}
        >
          <Link href={brand.ctaPrimary.href} className="mk-btn mk-btn-primary">
            {brand.ctaPrimary.label}
          </Link>
          <Link href={brand.ctaSecondary.href} className="mk-btn mk-btn-ghost">
            {brand.ctaSecondary.label}
          </Link>
        </motion.div>
      </div>
    </section>
  );
}

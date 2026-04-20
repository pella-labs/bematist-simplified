"use client";

import { brand } from "@bematist/ui/brand";
import { motion } from "motion/react";
import Link from "next/link";

export function CtaBand() {
  return (
    <section aria-labelledby="cta-heading">
      <div className="mk-cta-band">
        <motion.span
          className="mk-sys"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4 }}
        >
          02 / Get started
        </motion.span>
        <motion.h2
          id="cta-heading"
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        >
          Start measuring in 90 seconds.
        </motion.h2>
        <motion.div
          className="mk-cta-actions"
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.5, ease: "easeOut", delay: 0.1 }}
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

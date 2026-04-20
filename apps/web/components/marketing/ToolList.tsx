"use client";

import { brand } from "@bematist/ui/brand";
import { motion } from "motion/react";

export function ToolList() {
  return (
    <ul aria-label="Supported tools" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {brand.tools.map((tool, i) => (
        <motion.li
          key={tool.id}
          className="mk-tool-row"
          initial={{ opacity: 0, y: 8 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ duration: 0.35, ease: "easeOut", delay: i * 0.05 }}
        >
          <span className="mk-tool-name">{tool.name}</span>
          <span className="mk-tool-iface">{tool.iface}</span>
          <span className="mk-tool-captures">{tool.captures}</span>
        </motion.li>
      ))}
    </ul>
  );
}

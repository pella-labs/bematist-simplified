"use client";

import { motion } from "motion/react";

export type TerminalLine =
  | { id: string; kind: "comment"; text: string }
  | { id: string; kind: "command"; text: string }
  | { id: string; kind: "spacer" };

export function Terminal({ lines }: { lines: TerminalLine[] }) {
  return (
    <motion.div
      className="mk-terminal"
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      {lines.map((line) => {
        if (line.kind === "spacer") {
          return <div key={line.id} style={{ height: 8 }} />;
        }
        if (line.kind === "comment") {
          return (
            <div key={line.id} className="mk-term-comment">
              # {line.text}
            </div>
          );
        }
        return (
          <div key={line.id}>
            <span className="mk-term-prompt">$</span>
            <span className="mk-term-cmd">{line.text}</span>
          </div>
        );
      })}
    </motion.div>
  );
}

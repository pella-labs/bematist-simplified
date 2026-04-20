"use client";

import { motion } from "motion/react";
import { formatDurationMs, formatTokens, formatUsd } from "./format";
import type { TranscriptItem } from "./queries";

function classifyKind(kind: TranscriptItem["kind"]): "user" | "assistant" | "tool" {
  if (kind === "user_prompt") return "user";
  if (kind === "assistant_response") return "assistant";
  return "tool";
}

function kindLabel(kind: TranscriptItem["kind"]): string {
  switch (kind) {
    case "user_prompt":
      return "User prompt";
    case "assistant_response":
      return "Assistant response";
    case "tool_call":
      return "Tool call";
    case "tool_result":
      return "Tool result";
    case "session_start":
      return "Session start";
    case "session_end":
      return "Session end";
  }
}

function Turn({ item, index }: { item: TranscriptItem; index: number }) {
  const kindClass = classifyKind(item.kind);
  const meta: string[] = [];
  if (item.inputTokens || item.outputTokens) {
    meta.push(
      `${formatTokens(item.inputTokens ?? 0)} in / ${formatTokens(item.outputTokens ?? 0)} out`,
    );
  }
  if (item.cacheReadTokens || item.cacheCreationTokens) {
    meta.push(
      `cache ${formatTokens(item.cacheReadTokens ?? 0)}r / ${formatTokens(
        item.cacheCreationTokens ?? 0,
      )}w`,
    );
  }
  if (item.durationMs) meta.push(formatDurationMs(item.durationMs));
  if (item.costUsd != null) meta.push(formatUsd(item.costUsd, 4));
  if (item.toolName) meta.push(`tool: ${item.toolName}`);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: "easeOut", delay: Math.min(index * 0.02, 0.2) }}
      className="dash-turn"
    >
      <div className="dash-turn-head">
        <span className={`dash-turn-kind is-${kindClass}`}>{kindLabel(item.kind)}</span>
        <span className="dash-mono" style={{ color: "var(--mk-ink-faint)", fontSize: 11 }}>
          #{item.eventSeq} · {item.ts.toISOString().slice(11, 19)}
        </span>
      </div>
      {item.promptText ? <div className="dash-turn-body">{item.promptText}</div> : null}
      {meta.length > 0 ? <div className="dash-turn-meta">{meta.join(" · ")}</div> : null}
    </motion.div>
  );
}

export function Transcript({ items }: { items: TranscriptItem[] }) {
  if (items.length === 0) {
    return (
      <div className="dash-empty">
        <h3 className="dash-empty-title">No events recorded yet</h3>
        <p className="dash-empty-body">
          Events will appear here within a few seconds of the session starting.
        </p>
      </div>
    );
  }
  return (
    <div className="dash-transcript">
      {items.map((item, idx) => (
        <Turn key={item.id} item={item} index={idx} />
      ))}
    </div>
  );
}

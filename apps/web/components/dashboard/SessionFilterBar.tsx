"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

export interface SessionFilterBarProps {
  developers: Array<{ id: string; label: string }>;
  selectedDeveloperId: string;
  selectedSource: string;
}

export function SessionFilterBar({
  developers,
  selectedDeveloperId,
  selectedSource,
}: SessionFilterBarProps) {
  const router = useRouter();
  const params = useSearchParams();

  const setParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params?.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      const qs = next.toString();
      router.replace(qs ? `/sessions?${qs}` : "/sessions");
    },
    [params, router],
  );

  return (
    <div className="dash-filter-bar">
      <span className="dash-filter-label">Filter</span>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="dash-filter-label">Developer</span>
        <select
          className="dash-filter-select"
          value={selectedDeveloperId}
          onChange={(e) => setParam("developer", e.target.value)}
          aria-label="Filter by developer"
        >
          <option value="">All</option>
          {developers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="dash-filter-label">Source</span>
        <select
          className="dash-filter-select"
          value={selectedSource}
          onChange={(e) => setParam("source", e.target.value)}
          aria-label="Filter by source"
        >
          <option value="">All</option>
          <option value="claude-code">Claude Code</option>
          <option value="codex">Codex CLI</option>
          <option value="cursor">Cursor</option>
        </select>
      </label>
      {(selectedDeveloperId || selectedSource) && (
        <button type="button" className="dash-btn" onClick={() => router.replace("/sessions")}>
          Clear
        </button>
      )}
    </div>
  );
}

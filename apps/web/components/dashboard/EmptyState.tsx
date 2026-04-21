import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  body: ReactNode;
}

export function EmptyState({ title, body }: EmptyStateProps) {
  return (
    <div className="dash-empty" role="status">
      <h3 className="dash-empty-title">{title}</h3>
      <div className="dash-empty-body">{body}</div>
    </div>
  );
}

export function NoSessionsEmpty() {
  return (
    <EmptyState
      title="No sessions yet"
      body={
        <>
          Install the binary to start streaming telemetry. On a developer machine run{" "}
          <code>curl -fsSL https://web-production-0aec1.up.railway.app/install.sh | sh</code>, then{" "}
          <code>bm-pilot login &lt;token&gt;</code> and <code>bm-pilot start</code>. The daemon
          auto-detects Claude Code, Codex, and Cursor, installs their hooks, and runs in the
          background.
        </>
      }
    />
  );
}

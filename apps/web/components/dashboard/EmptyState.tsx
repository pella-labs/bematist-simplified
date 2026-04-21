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
          Install the binary to start streaming telemetry. Run{" "}
          <code>curl -fsSL https://bm-pilot.up.railway.app/install.sh | sh</code> on a developer
          machine, then <code>bematist login</code> and <code>bematist run</code>.
        </>
      }
    />
  );
}

"use client";

import { useState, useTransition } from "react";
import { revokeAllKeysForDeveloper, updateSubscriptionTier } from "./actions";

type Tier = "claude" | "codex" | "cursor";

export interface DeveloperTierFormProps {
  developerId: string;
  current: Record<Tier, string | null>;
  options: Record<Tier, Array<{ id: string; label: string }>>;
}

function TierSelect({
  developerId,
  tier,
  value,
  options,
}: {
  developerId: string;
  tier: Tier;
  value: string | null;
  options: Array<{ id: string; label: string }>;
}) {
  const [pending, startTransition] = useTransition();
  const [current, setCurrent] = useState<string>(value ?? "");
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
      <span className="dash-filter-label">{tier}</span>
      <select
        className="dash-filter-select"
        value={current}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          setCurrent(next);
          startTransition(async () => {
            await updateSubscriptionTier(developerId, tier, next);
          });
        }}
        aria-label={`Subscription tier for ${tier}`}
      >
        <option value="">None</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function DeveloperTierForm({ developerId, current, options }: DeveloperTierFormProps) {
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      <TierSelect
        developerId={developerId}
        tier="claude"
        value={current.claude}
        options={options.claude}
      />
      <TierSelect
        developerId={developerId}
        tier="codex"
        value={current.codex}
        options={options.codex}
      />
      <TierSelect
        developerId={developerId}
        tier="cursor"
        value={current.cursor}
        options={options.cursor}
      />
    </div>
  );
}

function Revoker({ developerId }: { developerId: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className="dash-btn is-danger"
        disabled={pending}
        onClick={() => {
          setMessage(null);
          startTransition(async () => {
            const res = await revokeAllKeysForDeveloper(developerId);
            if (res.ok) {
              setMessage(`Revoked ${res.revoked}`);
            } else {
              setMessage(res.error);
            }
          });
        }}
      >
        Revoke keys
      </button>
      {message ? (
        <span className="dash-mono" style={{ fontSize: 11, color: "var(--mk-ink-muted)" }}>
          {message}
        </span>
      ) : null}
    </div>
  );
}

DeveloperTierForm.Revoker = Revoker;

"use client";

import { useState, useTransition } from "react";
import { mintIngestKeyForDeveloper, revokeKey } from "./actions";

export function MintKeyForm() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setPlaintext(null);
        startTransition(async () => {
          const res = await mintIngestKeyForDeveloper(email, name);
          if (res.ok) {
            setPlaintext(res.plaintext);
            setEmail("");
            setName("");
          } else {
            setError(res.error);
          }
        });
      }}
    >
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 220 }}>
          <span className="dash-filter-label">Email</span>
          <input
            type="email"
            required
            className="dash-filter-input"
            placeholder="developer@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={pending}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 220 }}>
          <span className="dash-filter-label">Name (optional)</span>
          <input
            type="text"
            className="dash-filter-input"
            placeholder="First Last"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
          />
        </label>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button type="submit" className="dash-btn is-primary" disabled={pending}>
          {pending ? "Creating…" : "Mint key"}
        </button>
        {error ? (
          <span className="dash-mono" style={{ color: "var(--mk-warm)", fontSize: 12 }}>
            {error}
          </span>
        ) : null}
      </div>
      {plaintext ? (
        <div className="dash-banner is-ok" style={{ marginTop: 8 }}>
          <div className="dash-filter-label" style={{ marginBottom: 8, color: "var(--mk-accent)" }}>
            Copy now — you cannot retrieve this again
          </div>
          <code
            className="dash-mono"
            style={{
              display: "block",
              padding: 10,
              background: "var(--mk-bg-terminal)",
              border: "1px solid var(--mk-border)",
              fontSize: 13,
              wordBreak: "break-all",
            }}
          >
            {plaintext}
          </code>
        </div>
      ) : null}
    </form>
  );
}

export function KeyActions({ keyId }: { keyId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <button
        type="button"
        className="dash-btn is-danger"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const res = await revokeKey(keyId);
            if (!res.ok) setError(res.error);
          });
        }}
      >
        Revoke
      </button>
      {error ? (
        <span className="dash-mono" style={{ color: "var(--mk-warm)", fontSize: 11 }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

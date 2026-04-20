"use client";

import { createAuthClient } from "better-auth/client";
import { motion } from "motion/react";
import { useState } from "react";

const authClient = createAuthClient({ basePath: "/api/auth" });

export interface SignInClientProps {
  callbackURL: string;
}

export function SignInClient({ callbackURL }: SignInClientProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function signIn() {
    setError(null);
    setPending(true);
    try {
      await authClient.signIn.social({ provider: "github", callbackURL });
    } catch (err) {
      setError(err instanceof Error ? err.message : "sign-in failed");
      setPending(false);
    }
  }

  return (
    <motion.div
      className="mk-auth-card"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      <div className="mk-auth-label">Authenticate</div>
      <h1 className="mk-auth-title">Sign in with GitHub</h1>
      <p className="mk-auth-lede">
        We use your GitHub account to verify identity and connect your merged PRs. No passwords, no
        magic links.
      </p>
      <button
        type="button"
        className="mk-auth-btn"
        onClick={signIn}
        disabled={pending}
        aria-busy={pending}
      >
        <GitHubMark />
        <span>{pending ? "Redirecting…" : "Continue with GitHub"}</span>
      </button>
      {error ? (
        <p className="mk-auth-err" role="alert">
          {error}
        </p>
      ) : null}
      <p className="mk-auth-fine">
        Scopes requested: <code>read:user</code>, <code>public_repo</code>. We only use{" "}
        <code>public_repo</code> to read repositories you install our GitHub App on.
      </p>
    </motion.div>
  );
}

function GitHubMark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="GitHub"
    >
      <title>GitHub</title>
      <path d="M12 .5C5.73.5.75 5.48.75 11.75c0 4.97 3.22 9.18 7.69 10.67.56.1.77-.24.77-.54v-1.9c-3.13.68-3.79-1.5-3.79-1.5-.51-1.29-1.24-1.63-1.24-1.63-1.01-.69.08-.68.08-.68 1.11.08 1.7 1.14 1.7 1.14.99 1.69 2.6 1.2 3.24.92.1-.72.39-1.2.7-1.47-2.5-.29-5.13-1.25-5.13-5.55 0-1.23.44-2.23 1.14-3.02-.11-.28-.49-1.42.11-2.95 0 0 .93-.3 3.05 1.15.89-.25 1.84-.37 2.78-.38.94.01 1.89.13 2.78.38 2.12-1.45 3.05-1.15 3.05-1.15.6 1.53.22 2.67.11 2.95.71.79 1.14 1.79 1.14 3.02 0 4.31-2.63 5.25-5.14 5.54.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.78.54 4.46-1.49 7.68-5.7 7.68-10.67C23.25 5.48 18.27.5 12 .5Z" />
    </svg>
  );
}

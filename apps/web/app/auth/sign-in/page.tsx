import { brand } from "@bematist/ui/brand";
import type { Metadata } from "next";
import Link from "next/link";
import { SignInClient } from "./SignInClient";
import "../../(marketing)/marketing.css";
import "./auth.css";

export const metadata: Metadata = {
  title: `Sign in — ${brand.name}`,
  description: "Sign in with GitHub to access your team's AI-coding telemetry.",
};

interface PageProps {
  searchParams: Promise<{ invite?: string; callbackURL?: string }>;
}

export default async function SignInPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const callback = resolveCallback(sp.invite, sp.callbackURL);
  return (
    <div className="bematist-marketing">
      <div className="mk-container mk-auth-container">
        <header className="mk-auth-nav">
          <Link href="/" className="mk-wordmark" aria-label={`${brand.name} home`}>
            <span className="mk-wordmark-dot" aria-hidden />
            {brand.wordmark}
          </Link>
          <Link href="/" className="mk-nav-link">
            Back
          </Link>
        </header>
        <main className="mk-auth-main">
          <div className="mk-auth-grid" aria-hidden />
          <SignInClient callbackURL={callback} />
        </main>
      </div>
    </div>
  );
}

function resolveCallback(invite: string | undefined, callbackURL: string | undefined): string {
  if (invite) {
    return `/post-auth/accept-invite?token=${encodeURIComponent(invite)}`;
  }
  if (callbackURL?.startsWith("/")) {
    return callbackURL;
  }
  return "/post-auth/new-org";
}

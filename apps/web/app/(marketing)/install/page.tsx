import { brand } from "@bematist/ui/brand";
import type { Metadata } from "next";
import Link from "next/link";
import { Terminal } from "@/components/marketing/Terminal";
import { ToolList } from "@/components/marketing/ToolList";

const TITLE = `Install · ${brand.name}`;
const DESCRIPTION =
  "One signed binary reads session files from Claude Code, Codex CLI, and Cursor and forwards structured events to the Bematist ingest endpoint.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/install" },
};

export default function InstallPage() {
  return (
    <>
      <section className="mk-install-hero" aria-labelledby="install-hero-title">
        <span className="mk-sys" style={{ display: "block", marginBottom: 20 }}>
          install
        </span>
        <h1 id="install-hero-title">One binary. Three tools. Ninety seconds.</h1>
        <p>
          The Bematist collector runs as a small daemon on each engineer&apos;s machine. It tails
          the session files your coding agents already write to disk, normalizes them, and forwards
          prompt-level events to your ingest endpoint. No API keys to proxy, no plugins to install.
        </p>
        <div className="mk-hero-actions" style={{ justifyContent: "center" }}>
          <Link href={brand.ctaPrimary.href} className="mk-btn mk-btn-primary">
            {brand.ctaPrimary.label}
          </Link>
          <a href={brand.github} className="mk-btn mk-btn-ghost" rel="noreferrer" target="_blank">
            GitHub
          </a>
        </div>
      </section>

      <section aria-labelledby="install-command-heading">
        <div className="mk-section-header">
          <span id="install-command-heading" className="mk-mono mk-xs mk-muted">
            01 / One-line install
          </span>
        </div>
        <div className="mk-install-block">
          <span className="mk-install-label">macOS · Linux</span>
          <Terminal
            lines={[
              {
                id: "install-comment-download",
                kind: "comment",
                text: "Download, verify, and start the collector",
              },
              { id: "install-cmd-curl", kind: "command", text: brand.installCommand },
              { id: "install-spacer", kind: "spacer" },
              {
                id: "install-comment-token",
                kind: "comment",
                text: "Then point it at your org token",
              },
              {
                id: "install-cmd-serve",
                kind: "command",
                text: "bm-pilot serve --token $BM_PILOT_TOKEN",
              },
            ]}
          />
          <p className="mk-muted" style={{ marginTop: 16, fontSize: 13, maxWidth: 720 }}>
            The installer is signed and pinned to{" "}
            <code className="mk-mono">{brand.installHost}</code>. A Windows build is available from
            GitHub releases — the five-dev Windows host in our internal dogfood runs the same
            binary.
          </p>
        </div>
      </section>

      <section aria-labelledby="tools-heading">
        <div className="mk-section-header">
          <span id="tools-heading" className="mk-mono mk-xs mk-muted">
            02 / Tools the collector understands today
          </span>
        </div>
        <ToolList />
      </section>

      <section aria-labelledby="next-steps-heading">
        <div className="mk-section-header">
          <span id="next-steps-heading" className="mk-mono mk-xs mk-muted">
            03 / After it is running
          </span>
        </div>
        <div className="mk-install-block">
          <p className="mk-muted" style={{ maxWidth: 720, fontSize: 15 }}>
            Sign in with GitHub, install the Bematist GitHub App on the repos you want to measure,
            and prompts will start linking to the commits and PRs they produced. The dashboard shows
            per-developer usage, outcomes, and the delta between what your team paid on Claude Max,
            Pro, or Cursor subs versus what the same traffic would have cost on direct API pricing.
          </p>
          <div className="mk-hero-actions" style={{ marginTop: 32 }}>
            <Link href={brand.ctaPrimary.href} className="mk-btn mk-btn-primary">
              Sign in with GitHub
            </Link>
            <Link href="/" className="mk-btn mk-btn-ghost">
              Back to home
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

export const brand = {
  name: "Bematist",
  wordmark: "bematist",
  tagline: "Measure which prompts actually ship.",
  subtitle:
    "Per-developer AI-coding telemetry. See the ROI of Claude Code, Codex, and Cursor across your team, and what you would have paid on API pricing.",
  ctaPrimary: { label: "Sign in with GitHub", href: "/auth/sign-in" },
  ctaSecondary: { label: "Install the collector", href: "/install" },
  installCommand: "curl -fsSL https://web-production-0aec1.up.railway.app/install.sh | sh",
  installHost: "web-production-0aec1.up.railway.app",
  github: "https://github.com/pella-labs/bematist-simplified",
  footerTagline: "Prompt-level AI-coding telemetry. Ship the signal, skip the vanity.",
  tools: [
    {
      id: "claude-code",
      name: "Claude Code",
      iface: "CLI",
      captures:
        "Sessions, token counts, tool calls, accepted edits — straight from the local JSONL.",
    },
    {
      id: "codex",
      name: "Codex CLI",
      iface: "CLI",
      captures:
        "Per-turn token deltas, tool executions, and cost. Rollout tail works on macOS, Linux, and Windows.",
    },
    {
      id: "cursor",
      name: "Cursor",
      iface: "IDE",
      captures:
        "Generations, accept or reject, mode, and the bill you would have run up on direct API pricing.",
    },
  ],
  features: [
    {
      eyebrow: "01",
      title: "Prompt outcomes",
      body: "Every prompt linked to the commit or PR it produced. See which workflows actually ship and which burn tokens.",
    },
    {
      eyebrow: "02",
      title: "Subscription vs API delta",
      body: "See whether your Max and Pro subscriptions are a bargain or over-provisioned — per developer, per month.",
    },
    {
      eyebrow: "03",
      title: "Per-developer clarity",
      body: "Real names. Real sessions. Real cost. No leaderboards, no vanity metrics, no scoring framework.",
    },
  ],
  colors: {
    bg: "#0a0b0d",
    bgElevated: "#111316",
    bgTerminal: "#050506",
    ink: "#ede8de",
    inkMuted: "rgba(237, 232, 222, 0.6)",
    inkFaint: "rgba(237, 232, 222, 0.3)",
    border: "rgba(237, 232, 222, 0.12)",
    borderHover: "rgba(237, 232, 222, 0.3)",
    accent: "#6e8a6f",
    accentMuted: "rgba(110, 138, 111, 0.15)",
    warm: "#b07b3e",
  },
  gridSize: "24px",
} as const;

export type Brand = typeof brand;

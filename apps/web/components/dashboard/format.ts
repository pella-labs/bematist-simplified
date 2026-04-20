export type AttributionSignal = "cwd_time" | "trailer" | "webhook_scan";

export function formatUsd(value: number, decimals: 2 | 4 = 2): string {
  if (!Number.isFinite(value)) return "$0.00";
  const fixed = value.toFixed(decimals);
  const [intPart, frac] = fixed.split(".") as [string, string | undefined];
  const sign = intPart.startsWith("-") ? "-" : "";
  const digits = sign ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${grouped}${frac !== undefined ? `.${frac}` : ""}`;
}

export function formatSignedUsd(value: number, decimals: 2 | 4 = 2): string {
  const formatted = formatUsd(Math.abs(value), decimals);
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return formatted;
}

export function formatInt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return "0";
  return Math.trunc(Number(value)).toLocaleString("en-US");
}

export function formatTokens(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  }
  if (Math.abs(n) >= 1_000) {
    return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  }
  return String(Math.trunc(n));
}

export function formatRelative(from: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - from.getTime();
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < minute) return "just now";
  if (abs < hour) {
    const mins = Math.round(abs / minute);
    return diffMs >= 0 ? `${mins}m ago` : `in ${mins}m`;
  }
  if (abs < day) {
    const hrs = Math.round(abs / hour);
    return diffMs >= 0 ? `${hrs}h ago` : `in ${hrs}h`;
  }
  const days = Math.round(abs / day);
  if (days < 30) return diffMs >= 0 ? `${days}d ago` : `in ${days}d`;
  return from.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1_000);
  return `${mins}m ${secs}s`;
}

const SIGNAL_LABELS: Record<AttributionSignal, string> = {
  cwd_time: "cwd + time",
  trailer: "commit trailer",
  webhook_scan: "webhook scan",
};

export function signalLabel(signal: AttributionSignal): string {
  return SIGNAL_LABELS[signal];
}

export function currentMonthWindow(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function truncateMiddle(value: string, max = 40): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

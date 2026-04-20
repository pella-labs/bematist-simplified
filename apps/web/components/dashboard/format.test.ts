import { describe, expect, test } from "bun:test";
import {
  currentMonthWindow,
  formatDurationMs,
  formatInt,
  formatRelative,
  formatSignedUsd,
  formatTokens,
  formatUsd,
  monthKey,
  shortSha,
  signalLabel,
  truncateMiddle,
} from "./format";

describe("formatUsd", () => {
  test("formats 2-decimal USD with thousands separators", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1000000)).toBe("$1,000,000.00");
  });
  test("formats 4-decimal USD", () => {
    expect(formatUsd(0.0001, 4)).toBe("$0.0001");
    expect(formatUsd(12.345678, 4)).toBe("$12.3457");
  });
  test("handles negatives", () => {
    expect(formatUsd(-12.5)).toBe("-$12.50");
  });
  test("handles non-finite", () => {
    expect(formatUsd(Number.NaN)).toBe("$0.00");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("$0.00");
  });
});

describe("formatSignedUsd", () => {
  test("prefixes explicit sign", () => {
    expect(formatSignedUsd(12.5)).toBe("+$12.50");
    expect(formatSignedUsd(-12.5)).toBe("-$12.50");
    expect(formatSignedUsd(0)).toBe("$0.00");
  });
});

describe("formatInt", () => {
  test("formats ints with thousands", () => {
    expect(formatInt(1234)).toBe("1,234");
    expect(formatInt(0)).toBe("0");
    expect(formatInt(null)).toBe("0");
    expect(formatInt(undefined)).toBe("0");
  });
});

describe("formatTokens", () => {
  test("humanizes token counts", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(12345)).toBe("12k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(null)).toBe("0");
  });
});

describe("formatRelative", () => {
  test("returns relative strings", () => {
    const now = new Date("2026-04-20T12:00:00Z");
    expect(formatRelative(new Date("2026-04-20T11:59:30Z"), now)).toBe("just now");
    expect(formatRelative(new Date("2026-04-20T11:00:00Z"), now)).toBe("1h ago");
    expect(formatRelative(new Date("2026-04-19T12:00:00Z"), now)).toBe("1d ago");
    expect(formatRelative(new Date("2026-04-20T11:30:00Z"), now)).toBe("30m ago");
  });
  test("falls back to absolute date for older entries", () => {
    const now = new Date("2026-04-20T12:00:00Z");
    const older = new Date("2025-12-01T00:00:00Z");
    const text = formatRelative(older, now);
    expect(text).toMatch(/2025/);
  });
});

describe("formatDurationMs", () => {
  test("formats ms/s/m", () => {
    expect(formatDurationMs(null)).toBe("—");
    expect(formatDurationMs(0)).toBe("—");
    expect(formatDurationMs(250)).toBe("250ms");
    expect(formatDurationMs(1500)).toBe("1.5s");
    expect(formatDurationMs(65_000)).toBe("1m 5s");
  });
});

describe("signalLabel", () => {
  test("maps signals to pretty labels", () => {
    expect(signalLabel("cwd_time")).toBe("cwd + time");
    expect(signalLabel("trailer")).toBe("commit trailer");
    expect(signalLabel("webhook_scan")).toBe("webhook scan");
  });
});

describe("currentMonthWindow + monthKey", () => {
  test("returns a UTC month window", () => {
    const window = currentMonthWindow(new Date("2026-04-20T12:00:00Z"));
    expect(window.start.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
  test("monthKey is yyyy-mm", () => {
    expect(monthKey(new Date("2026-04-20T12:00:00Z"))).toBe("2026-04");
    expect(monthKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });
});

describe("truncateMiddle + shortSha", () => {
  test("short values unchanged", () => {
    expect(truncateMiddle("abc")).toBe("abc");
  });
  test("long values truncated in the middle", () => {
    const s = "a".repeat(100);
    const result = truncateMiddle(s, 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toContain("…");
  });
  test("shortSha truncates to 7", () => {
    expect(shortSha("abcdef1234567890")).toBe("abcdef1");
  });
});

import { type Config, readConfig, writeConfig } from "../config";
import type { BackfillResult } from "./backfill";

export interface ConsentPrompts {
  prompt(question: string): Promise<string>;
}

export interface HistoricalCounts {
  claudeCode: number;
  codex: number;
  oldestMtime?: number;
}

export type ConsentFlag = "accept" | "decline" | null;

export interface ConsentDeps {
  configPath: string;
  prompts: ConsentPrompts;
  detectHistorical: () => Promise<HistoricalCounts>;
  runBackfill: () => Promise<BackfillResult>;
  now: () => string;
  out: (line: string) => void;
  isTty: boolean;
  flag: ConsentFlag;
}

export type ConsentResult =
  | { ran: false; reason: "already-asked"; accepted: boolean }
  | { ran: false; reason: "no-history" }
  | { ran: false; reason: "non-interactive" }
  | { ran: false; reason: "declined" }
  | { ran: false; reason: "flag-declined" }
  | { ran: true; result: BackfillResult };

export async function ensureBackfillConsent(deps: ConsentDeps): Promise<ConsentResult> {
  const current = await readConfig(deps.configPath);
  if (!current) {
    return { ran: false, reason: "no-history" };
  }

  if (current.onboarding?.backfillPromptedAt) {
    return {
      ran: false,
      reason: "already-asked",
      accepted: current.onboarding.backfillAccepted ?? false,
    };
  }

  if (deps.flag === "accept") {
    await persist(deps, current, true);
    return runAndReturn(deps);
  }
  if (deps.flag === "decline") {
    await persist(deps, current, false);
    return { ran: false, reason: "flag-declined" };
  }

  const counts = await deps.detectHistorical();
  const total = counts.claudeCode + counts.codex;
  if (total === 0) {
    await persist(deps, current, false);
    return { ran: false, reason: "no-history" };
  }

  if (!deps.isTty) {
    deps.out("[skip] backfill (non-interactive)");
    await persist(deps, current, false);
    return { ran: false, reason: "non-interactive" };
  }

  const oldest = counts.oldestMtime
    ? new Date(counts.oldestMtime).toISOString().slice(0, 10)
    : "unknown";
  deps.out(
    `found ${total} historical sessions (${counts.claudeCode} claude-code + ${counts.codex} codex, oldest ${oldest}).`,
  );
  const answer = (await deps.prompts.prompt("include them? [y/N] ")).trim();
  const yes = /^y(es)?$/i.test(answer);

  if (!yes) {
    await persist(deps, current, false);
    return { ran: false, reason: "declined" };
  }

  await persist(deps, current, true);
  return runAndReturn(deps);
}

async function runAndReturn(deps: ConsentDeps): Promise<ConsentResult> {
  const result = await deps.runBackfill();
  return { ran: true, result };
}

async function persist(deps: ConsentDeps, current: Config, accepted: boolean): Promise<void> {
  const next: Config = {
    ...current,
    onboarding: {
      ...(current.onboarding ?? {}),
      backfillPromptedAt: deps.now(),
      backfillAccepted: accepted,
    },
  };
  await writeConfig(next, deps.configPath);
}

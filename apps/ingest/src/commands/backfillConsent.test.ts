import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, freshConfig, writeConfig } from "../config";
import type { BackfillResult } from "./backfill";
import { type ConsentDeps, type ConsentResult, ensureBackfillConsent } from "./backfillConsent";

let tmp: string;
let cfgPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bm-consent-"));
  cfgPath = join(tmp, "config.json");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function validKey(): string {
  return `bm_01234567-89ab-cdef-0123-456789abcdef_keyId012_${"a".repeat(32)}`;
}

async function seedConfig(overrides: Partial<Config> = {}): Promise<void> {
  const c = freshConfig("http://localhost:8000");
  await writeConfig({ ...c, ingestKey: validKey(), ...overrides }, cfgPath);
}

interface Stubs {
  prompts: Array<{ q: string }>;
  promptAnswers: string[];
  detectCalls: number;
  runCalls: number;
  outLines: string[];
  deps: ConsentDeps;
  runImpl: () => Promise<BackfillResult>;
  detectImpl: () => Promise<{
    claudeCode: number;
    codex: number;
    oldestMtime?: number;
  }>;
}

function makeStubs(init: {
  answers?: string[];
  detect?: () => Promise<{ claudeCode: number; codex: number; oldestMtime?: number }>;
  run?: () => Promise<BackfillResult>;
  flag?: "accept" | "decline";
  isTty?: boolean;
  nowIso?: string;
}): Stubs {
  const stubs: Stubs = {
    prompts: [],
    promptAnswers: init.answers ?? [],
    detectCalls: 0,
    runCalls: 0,
    outLines: [],
    detectImpl: init.detect ?? (async () => ({ claudeCode: 0, codex: 0, oldestMtime: undefined })),
    runImpl:
      init.run ??
      (async () => ({
        exitCode: 0,
        summary: {
          claude_code: { files: 1, envelopes: 2, bytes: 3 },
          cursor: { skipped: true, reason: "no historical record" },
        },
      })),
    deps: {} as ConsentDeps,
  };
  stubs.deps = {
    configPath: cfgPath,
    prompts: {
      async prompt(q: string) {
        stubs.prompts.push({ q });
        return stubs.promptAnswers.shift() ?? "";
      },
    },
    detectHistorical: async () => {
      stubs.detectCalls++;
      return stubs.detectImpl();
    },
    runBackfill: async () => {
      stubs.runCalls++;
      return stubs.runImpl();
    },
    now: () => init.nowIso ?? "2026-04-21T12:00:00.000Z",
    out: (line: string) => stubs.outLines.push(line),
    isTty: init.isTty ?? true,
    flag: init.flag ?? null,
  };
  return stubs;
}

async function readCfg(): Promise<Config> {
  return JSON.parse(await readFile(cfgPath, "utf8")) as Config;
}

describe("ensureBackfillConsent", () => {
  it("skips when already-asked + accepted (no prompt, no run)", async () => {
    await seedConfig({
      onboarding: {
        backfillPromptedAt: "2026-04-20T10:00:00.000Z",
        backfillAccepted: true,
      },
    });
    const s = makeStubs({});
    const r: ConsentResult = await ensureBackfillConsent(s.deps);

    expect(r.ran).toBe(false);
    if (r.ran) throw new Error("unreachable");
    expect(r.reason).toBe("already-asked");
    if (r.reason !== "already-asked") throw new Error("unreachable");
    expect(r.accepted).toBe(true);
    expect(s.prompts.length).toBe(0);
    expect(s.detectCalls).toBe(0);
    expect(s.runCalls).toBe(0);
  });

  it("skips when already-asked + declined (no prompt, no run)", async () => {
    await seedConfig({
      onboarding: {
        backfillPromptedAt: "2026-04-20T10:00:00.000Z",
        backfillAccepted: false,
      },
    });
    const s = makeStubs({});
    const r = await ensureBackfillConsent(s.deps);

    expect(r.ran).toBe(false);
    if (r.ran) throw new Error("unreachable");
    expect(r.reason).toBe("already-asked");
    if (r.reason !== "already-asked") throw new Error("unreachable");
    expect(r.accepted).toBe(false);
    expect(s.prompts.length).toBe(0);
    expect(s.detectCalls).toBe(0);
    expect(s.runCalls).toBe(0);
  });

  it("persists decline silently when never-asked + no-history", async () => {
    await seedConfig();
    const s = makeStubs({
      detect: async () => ({ claudeCode: 0, codex: 0 }),
      nowIso: "2026-04-21T12:00:00.000Z",
    });
    const r = await ensureBackfillConsent(s.deps);

    expect(r.ran).toBe(false);
    if (r.ran) throw new Error("unreachable");
    expect(r.reason).toBe("no-history");
    expect(s.prompts.length).toBe(0);
    expect(s.runCalls).toBe(0);

    const cfg = await readCfg();
    expect(cfg.onboarding?.backfillPromptedAt).toBe("2026-04-21T12:00:00.000Z");
    expect(cfg.onboarding?.backfillAccepted).toBe(false);
  });

  it("runs backfill on Y when never-asked + history present", async () => {
    await seedConfig();
    const s = makeStubs({
      detect: async () => ({
        claudeCode: 19,
        codex: 4,
        oldestMtime: Date.parse("2026-03-12T00:00:00.000Z"),
      }),
      answers: ["y"],
    });
    const r = await ensureBackfillConsent(s.deps);

    expect(r.ran).toBe(true);
    if (r.ran) expect(r.result.exitCode).toBe(0);
    expect(s.prompts.length).toBe(1);
    expect(s.prompts[0]?.q).toMatch(/include them/i);
    expect(s.runCalls).toBe(1);

    const cfg = await readCfg();
    expect(cfg.onboarding?.backfillAccepted).toBe(true);
    expect(cfg.onboarding?.backfillPromptedAt).toBe("2026-04-21T12:00:00.000Z");
  });

  it("does not run on N when never-asked + history present", async () => {
    await seedConfig();
    const s = makeStubs({
      detect: async () => ({ claudeCode: 2, codex: 0 }),
      answers: ["n"],
    });
    const r = await ensureBackfillConsent(s.deps);

    expect(r.ran).toBe(false);
    if (r.ran) throw new Error("unreachable");
    expect(r.reason).toBe("declined");
    expect(s.prompts.length).toBe(1);
    expect(s.runCalls).toBe(0);

    const cfg = await readCfg();
    expect(cfg.onboarding?.backfillAccepted).toBe(false);
  });

  it("treats empty answer (enter) as decline (default N)", async () => {
    await seedConfig();
    const s = makeStubs({
      detect: async () => ({ claudeCode: 3, codex: 1 }),
      answers: [""],
    });
    const r = await ensureBackfillConsent(s.deps);

    expect(r.ran).toBe(false);
    if (r.ran) throw new Error("unreachable");
    expect(r.reason).toBe("declined");
    expect(s.runCalls).toBe(0);
    const cfg = await readCfg();
    expect(cfg.onboarding?.backfillAccepted).toBe(false);
  });

  it("persists decline without prompting when non-interactive + history present + no flag", async () => {
    await seedConfig();
    const s = makeStubs({
      detect: async () => ({ claudeCode: 5, codex: 0 }),
      isTty: false,
    });
    const r = await ensureBackfillConsent(s.deps);

    expect(r.ran).toBe(false);
    if (r.ran) throw new Error("unreachable");
    expect(r.reason).toBe("non-interactive");
    expect(s.prompts.length).toBe(0);
    expect(s.runCalls).toBe(0);
    expect(s.outLines.some((l) => l.includes("[skip] backfill (non-interactive)"))).toBe(true);

    const cfg = await readCfg();
    expect(cfg.onboarding?.backfillAccepted).toBe(false);
  });

  it("runs without prompting when --backfill flag is passed", async () => {
    await seedConfig();
    const s = makeStubs({
      detect: async () => ({ claudeCode: 10, codex: 0 }),
      flag: "accept",
      isTty: false,
    });
    const r = await ensureBackfillConsent(s.deps);

    expect(r.ran).toBe(true);
    if (r.ran) expect(r.result.exitCode).toBe(0);
    expect(s.prompts.length).toBe(0);
    expect(s.runCalls).toBe(1);

    const cfg = await readCfg();
    expect(cfg.onboarding?.backfillAccepted).toBe(true);
  });

  it("does not run, persists decline without prompting when --no-backfill flag is passed", async () => {
    await seedConfig();
    const s = makeStubs({
      detect: async () => ({ claudeCode: 10, codex: 0 }),
      flag: "decline",
      isTty: true,
    });
    const r = await ensureBackfillConsent(s.deps);

    expect(r.ran).toBe(false);
    if (r.ran) throw new Error("unreachable");
    expect(r.reason).toBe("flag-declined");
    expect(s.prompts.length).toBe(0);
    expect(s.runCalls).toBe(0);

    const cfg = await readCfg();
    expect(cfg.onboarding?.backfillAccepted).toBe(false);
  });

  it("persists accepted even when runBackfill throws (prevents re-prompt loop) and bubbles error", async () => {
    await seedConfig();
    const s = makeStubs({
      detect: async () => ({ claudeCode: 7, codex: 2 }),
      answers: ["y"],
      run: async () => {
        throw new Error("upload failed");
      },
    });

    let caught: unknown = null;
    try {
      await ensureBackfillConsent(s.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/upload failed/);

    const cfg = await readCfg();
    expect(cfg.onboarding?.backfillAccepted).toBe(true);
    expect(cfg.onboarding?.backfillPromptedAt).toBeDefined();
  });

  it("prompt line shows total, per-adapter split, and oldest date", async () => {
    await seedConfig();
    const s = makeStubs({
      detect: async () => ({
        claudeCode: 19,
        codex: 4,
        oldestMtime: Date.parse("2026-03-12T00:00:00.000Z"),
      }),
      answers: ["n"],
    });
    await ensureBackfillConsent(s.deps);

    const printed = s.outLines.join("\n");
    expect(printed).toMatch(/23/);
    expect(printed).toMatch(/19 claude-code/);
    expect(printed).toMatch(/4 codex/);
    expect(printed).toMatch(/2026-03-12/);
  });
});

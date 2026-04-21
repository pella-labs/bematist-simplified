import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@bematist/contracts";
import { freshConfig, writeConfig } from "../config";
import type { UploadResult } from "../uploader";
import { UploadRetriesExhaustedError } from "../uploader";
import { runBackfill } from "./backfill";

function validKey(): string {
  return `bm_01234567-89ab-cdef-0123-456789abcdef_keyId012_${"a".repeat(32)}`;
}

async function seedConfig(cfgPath: string, loggedIn = true): Promise<void> {
  const c = freshConfig("http://localhost:8000");
  await writeConfig({ ...c, ingestKey: loggedIn ? validKey() : null }, cfgPath);
}

function claudeUserLine(uuid: string, sess: string, text: string, ts: string) {
  return `${JSON.stringify({
    type: "user",
    uuid,
    timestamp: ts,
    sessionId: sess,
    cwd: "/tmp/demo",
    gitBranch: "main",
    version: "2.1.76",
    message: { role: "user", content: text },
  })}\n`;
}

function codexMetaLine(sess: string, ts: string) {
  return `${JSON.stringify({
    timestamp: ts,
    type: "session_meta",
    payload: { id: sess, cwd: "/tmp/repo", cli_version: "0.120.0" },
  })}\n`;
}

function codexUserLine(sess: string, turn: string, text: string, ts: string) {
  return `${JSON.stringify({
    session_id: sess,
    turn_id: turn,
    timestamp: ts,
    event_msg: { type: "user_message", payload: { role: "user", content: text } },
  })}\n`;
}

interface FakeUploader {
  upload(batch: EventEnvelope[]): Promise<UploadResult>;
  calls: EventEnvelope[][];
}

function fakeUploader(failOn?: (batch: EventEnvelope[]) => boolean): FakeUploader {
  const calls: EventEnvelope[][] = [];
  return {
    calls,
    async upload(batch) {
      calls.push(batch);
      if (failOn?.(batch)) {
        throw new UploadRetriesExhaustedError(5, new Error("boom"));
      }
      return { accepted: batch.length, deduped: 0 };
    },
  };
}

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bm-pilot-backfill-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function seedClaudeFiles(): Promise<string[]> {
  const projectsDir = join(home, ".claude", "projects", "proj1");
  await mkdir(projectsDir, { recursive: true });
  const a = join(projectsDir, "sess-A.jsonl");
  const b = join(projectsDir, "sess-B.jsonl");
  await writeFile(
    a,
    claudeUserLine(
      "a1111111-1111-4111-8111-111111111111",
      "src-A",
      "hello",
      "2026-04-16T14:00:00.000Z",
    ),
  );
  await writeFile(
    b,
    claudeUserLine(
      "b2222222-2222-4222-8222-222222222222",
      "src-B",
      "world",
      "2026-04-16T14:00:00.000Z",
    ),
  );
  return [a, b];
}

async function seedCodexFiles(): Promise<string[]> {
  const sess = join(home, ".codex", "sessions", "2026", "04");
  await mkdir(sess, { recursive: true });
  const a = join(sess, "rollout-codex-A.jsonl");
  await writeFile(
    a,
    codexMetaLine("codex-A", "2026-04-16T14:00:00.000Z") +
      codexUserLine("codex-A", "t1", "hi", "2026-04-16T14:00:01.000Z"),
  );
  return [a];
}

describe("runBackfill", () => {
  it("refuses without a valid ingest key", async () => {
    const cfgPath = join(home, ".bm-pilot", "config.json");
    await seedConfig(cfgPath, false);
    const up = fakeUploader();

    const res = await runBackfill({
      configPath: cfgPath,
      home,
      env: {},
      since: "all",
      dryRun: false,
      force: false,
      adapter: null,
      json: false,
      uploader: up,
      isDaemonRunning: async () => false,
      log: () => {},
      err: () => {},
    });

    expect(res.exitCode).toBe(1);
    expect(up.calls.length).toBe(0);
  });

  it("refuses when the daemon PID file points to a live process", async () => {
    const cfgPath = join(home, ".bm-pilot", "config.json");
    await seedConfig(cfgPath, true);
    const up = fakeUploader();

    const res = await runBackfill({
      configPath: cfgPath,
      home,
      env: {},
      since: "all",
      dryRun: false,
      force: false,
      adapter: null,
      json: false,
      uploader: up,
      isDaemonRunning: async () => true,
      log: () => {},
      err: () => {},
    });

    expect(res.exitCode).toBe(1);
    expect(up.calls.length).toBe(0);
  });

  it("--force bypasses the daemon-running check", async () => {
    const cfgPath = join(home, ".bm-pilot", "config.json");
    await seedConfig(cfgPath, true);
    await seedClaudeFiles();
    const up = fakeUploader();

    const res = await runBackfill({
      configPath: cfgPath,
      home,
      env: {},
      since: "all",
      dryRun: false,
      force: true,
      adapter: "claude-code",
      json: false,
      uploader: up,
      isDaemonRunning: async () => true,
      log: () => {},
      err: () => {},
    });

    expect(res.exitCode).toBe(0);
    expect(up.calls.length).toBeGreaterThan(0);
  });

  it("emits session_start, then line envelopes, then session_end per file", async () => {
    const cfgPath = join(home, ".bm-pilot", "config.json");
    await seedConfig(cfgPath, true);
    await seedClaudeFiles();
    const up = fakeUploader();

    const res = await runBackfill({
      configPath: cfgPath,
      home,
      env: {},
      since: "all",
      dryRun: false,
      force: false,
      adapter: "claude-code",
      json: false,
      uploader: up,
      isDaemonRunning: async () => false,
      log: () => {},
      err: () => {},
    });

    expect(res.exitCode).toBe(0);
    const flat = up.calls.flat();
    const bySession = new Map<string, EventEnvelope[]>();
    for (const e of flat) {
      const list = bySession.get(e.session_id) ?? [];
      list.push(e);
      bySession.set(e.session_id, list);
    }
    expect(bySession.size).toBeGreaterThanOrEqual(2);
    for (const evs of bySession.values()) {
      expect(evs[0]?.kind).toBe("session_start");
      expect(evs[evs.length - 1]?.kind).toBe("session_end");
    }
  });

  it("dry-run emits nothing and reports counts", async () => {
    const cfgPath = join(home, ".bm-pilot", "config.json");
    await seedConfig(cfgPath, true);
    await seedClaudeFiles();
    const up = fakeUploader();

    const res = await runBackfill({
      configPath: cfgPath,
      home,
      env: {},
      since: "all",
      dryRun: true,
      force: false,
      adapter: "claude-code",
      json: true,
      uploader: up,
      isDaemonRunning: async () => false,
      log: () => {},
      err: () => {},
    });

    expect(res.exitCode).toBe(0);
    expect(up.calls.length).toBe(0);
    expect(res.summary.claude_code?.files).toBe(2);
  });

  it("advances offsets to EOF for claude-code after successful upload", async () => {
    const cfgPath = join(home, ".bm-pilot", "config.json");
    await seedConfig(cfgPath, true);
    const [a, b] = await seedClaudeFiles();
    if (!a || !b) throw new Error("fixtures");
    const up = fakeUploader();

    const res = await runBackfill({
      configPath: cfgPath,
      home,
      env: {},
      since: "all",
      dryRun: false,
      force: false,
      adapter: "claude-code",
      json: true,
      uploader: up,
      isDaemonRunning: async () => false,
      log: () => {},
      err: () => {},
    });

    expect(res.exitCode).toBe(0);
    const offsetsPath = join(home, ".bm-pilot", "offsets-claude-code.json");
    const parsed = JSON.parse(await readFile(offsetsPath, "utf8"));
    expect(parsed.version).toBe(1);
    expect(typeof parsed.files).toBe("object");
    const sizeA = (await import("node:fs")).statSync(a).size;
    const sizeB = (await import("node:fs")).statSync(b).size;
    expect(parsed.files[a]).toBe(sizeA);
    expect(parsed.files[b]).toBe(sizeB);
  });

  it("advances offsets to EOF for codex after successful upload", async () => {
    const cfgPath = join(home, ".bm-pilot", "config.json");
    await seedConfig(cfgPath, true);
    const [a] = await seedCodexFiles();
    if (!a) throw new Error("fixtures");
    const up = fakeUploader();

    const res = await runBackfill({
      configPath: cfgPath,
      home,
      env: {},
      since: "all",
      dryRun: false,
      force: false,
      adapter: "codex",
      json: true,
      uploader: up,
      isDaemonRunning: async () => false,
      log: () => {},
      err: () => {},
    });

    expect(res.exitCode).toBe(0);
    const offsetsPath = join(home, ".bm-pilot", "offsets-codex.json");
    const parsed = JSON.parse(await readFile(offsetsPath, "utf8"));
    expect(typeof parsed.codex).toBe("object");
    const size = (await import("node:fs")).statSync(a).size;
    expect(parsed.codex[a]).toBe(size);
  });

  it("returns nonzero and does not bump offsets on upload failure", async () => {
    const cfgPath = join(home, ".bm-pilot", "config.json");
    await seedConfig(cfgPath, true);
    const [a] = await seedClaudeFiles();
    if (!a) throw new Error("fixtures");
    const up = fakeUploader(() => true);

    const res = await runBackfill({
      configPath: cfgPath,
      home,
      env: {},
      since: "all",
      dryRun: false,
      force: false,
      adapter: "claude-code",
      json: false,
      uploader: up,
      isDaemonRunning: async () => false,
      log: () => {},
      err: () => {},
    });

    expect(res.exitCode).not.toBe(0);
    const offsetsPath = join(home, ".bm-pilot", "offsets-claude-code.json");
    const { existsSync } = await import("node:fs");
    expect(existsSync(offsetsPath)).toBe(false);
  });

  it("--since 7d skips files older than the cutoff", async () => {
    const cfgPath = join(home, ".bm-pilot", "config.json");
    await seedConfig(cfgPath, true);
    const [a, b] = await seedClaudeFiles();
    if (!a || !b) throw new Error("fixtures");
    const { utimes } = await import("node:fs/promises");
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(a, old, old);

    const up = fakeUploader();
    const res = await runBackfill({
      configPath: cfgPath,
      home,
      env: {},
      since: "7d",
      dryRun: false,
      force: false,
      adapter: "claude-code",
      json: true,
      uploader: up,
      isDaemonRunning: async () => false,
      log: () => {},
      err: () => {},
    });

    expect(res.exitCode).toBe(0);
    expect(res.summary.claude_code?.files).toBe(1);
    const flat = up.calls.flat();
    const srcIds = new Set(flat.map((e) => e.source_session_id));
    expect(srcIds.has("src-A")).toBe(false);
    expect(srcIds.has("src-B")).toBe(true);
  });

  it("cursor is always reported as skipped", async () => {
    const cfgPath = join(home, ".bm-pilot", "config.json");
    await seedConfig(cfgPath, true);
    const up = fakeUploader();
    const res = await runBackfill({
      configPath: cfgPath,
      home,
      env: {},
      since: "all",
      dryRun: false,
      force: false,
      adapter: null,
      json: true,
      uploader: up,
      isDaemonRunning: async () => false,
      log: () => {},
      err: () => {},
    });
    expect(res.exitCode).toBe(0);
    expect(res.summary.cursor?.skipped).toBe(true);
  });
});

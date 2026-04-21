import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EventEnvelope } from "@bematist/contracts";
import {
  enumerateHistoricalFiles as enumerateClaudeFiles,
  readFileToEnvelopes as readClaudeFile,
} from "../adapters/claude-code/backfillReader";
import {
  enumerateHistoricalFiles as enumerateCodexFiles,
  readFileToEnvelopes as readCodexFile,
} from "../adapters/codex/backfillReader";
import { validateIngestKey } from "../auth";
import { type Config, readConfig } from "../config";
import { CLIENT_VERSION } from "../daemon";
import type { Uploader } from "../uploader";
import { UploadRetriesExhaustedError } from "../uploader";

const BATCH_SIZE = 100;
const CLAUDE_OFFSETS_FILE = "offsets-claude-code.json";
const CODEX_OFFSETS_FILE = "offsets-codex.json";
const CODEX_LOCK_FILE = "offsets-codex.lock";

export type AdapterName = "claude-code" | "codex";

export interface AdapterSummary {
  files: number;
  envelopes: number;
  bytes: number;
}

export interface BackfillSummary {
  claude_code?: AdapterSummary;
  codex?: AdapterSummary;
  cursor?: { skipped: true; reason: string };
}

export interface BackfillResult {
  exitCode: number;
  summary: BackfillSummary;
}

export interface BackfillOptions {
  configPath: string;
  home: string;
  env: Record<string, string | undefined>;
  since: string | undefined;
  dryRun: boolean;
  force: boolean;
  adapter: AdapterName | null;
  json: boolean;
  uploader?: Pick<Uploader, "upload">;
  isDaemonRunning?: () => Promise<boolean>;
  now?: () => Date;
  log: (msg: string) => void;
  err: (msg: string) => void;
}

export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const log = opts.log;
  const err = opts.err;
  const now = opts.now ?? (() => new Date());

  const config = await readConfig(opts.configPath);
  if (!config) {
    err(`no config at ${opts.configPath} — run \`bm-pilot login <token>\` first`);
    return { exitCode: 1, summary: emptySummary() };
  }
  if (!config.ingestKey) {
    err("not logged in — run `bm-pilot login <token>` first");
    return { exitCode: 1, summary: emptySummary() };
  }
  try {
    validateIngestKey(config.ingestKey);
  } catch (e) {
    err(`invalid ingest key: ${messageOf(e)}`);
    return { exitCode: 1, summary: emptySummary() };
  }

  if (!opts.force) {
    const running = await (opts.isDaemonRunning
      ? opts.isDaemonRunning()
      : detectDaemonRunning(opts.home));
    if (running) {
      err("daemon is running — stop the service first or pass `--force`");
      return { exitCode: 1, summary: emptySummary() };
    }
  }

  const sinceMs = parseSince(opts.since, now());
  const uploader = opts.uploader ?? null;

  const adapters: AdapterName[] = opts.adapter === null ? ["claude-code", "codex"] : [opts.adapter];

  const summary: BackfillSummary = {
    cursor: { skipped: true, reason: "no historical record" },
  };
  let hadFailure = false;

  for (const adapter of adapters) {
    try {
      const out = await runForAdapter(adapter, {
        home: opts.home,
        env: opts.env,
        sinceMs,
        dryRun: opts.dryRun,
        uploader,
        config,
        log,
        err,
      });
      if (adapter === "claude-code") summary.claude_code = out;
      else summary.codex = out;
    } catch (e) {
      hadFailure = true;
      err(`${adapter}: backfill failed — ${messageOf(e)}`);
    }
  }

  emitSummary(summary, opts, log);

  return { exitCode: hadFailure ? 1 : 0, summary };
}

interface AdapterRunCtx {
  home: string;
  env: Record<string, string | undefined>;
  sinceMs: number;
  dryRun: boolean;
  uploader: Pick<Uploader, "upload"> | null;
  config: Config;
  log: (m: string) => void;
  err: (m: string) => void;
}

async function runForAdapter(adapter: AdapterName, ctx: AdapterRunCtx): Promise<AdapterSummary> {
  const root = resolveRoot(adapter, ctx.home, ctx.env);
  const files =
    adapter === "claude-code"
      ? await enumerateClaudeFiles({ root, sinceMs: ctx.sinceMs })
      : await enumerateCodexFiles({ root, sinceMs: ctx.sinceMs });

  const processedOffsets = new Map<string, number>();
  let envelopeCount = 0;
  let byteCount = 0;
  let batch: EventEnvelope[] = [];

  async function drain(): Promise<void> {
    if (batch.length === 0) return;
    if (ctx.dryRun) {
      batch = [];
      return;
    }
    if (!ctx.uploader) throw new Error("no uploader configured");
    const body = JSON.stringify(batch);
    byteCount += Buffer.byteLength(body, "utf8");
    try {
      await ctx.uploader.upload(batch);
    } catch (e) {
      if (e instanceof UploadRetriesExhaustedError) {
        throw new Error(`upload retries exhausted: ${messageOf(e)}`);
      }
      throw e;
    }
    batch = [];
  }

  for (const file of files) {
    const iter =
      adapter === "claude-code"
        ? readClaudeFile(file.path, {
            deviceId: ctx.config.deviceId,
            clientVersion: CLIENT_VERSION,
          })
        : readCodexFile(file.path, {
            deviceId: ctx.config.deviceId,
            clientVersion: CLIENT_VERSION,
          });

    for await (const env of iter) {
      envelopeCount++;
      batch.push(env);
      if (batch.length >= BATCH_SIZE) await drain();
    }
    const size = await safeStatSize(file.path);
    if (size !== null) processedOffsets.set(file.path, size);
  }

  await drain();

  if (!ctx.dryRun && processedOffsets.size > 0) {
    if (adapter === "claude-code") {
      await writeClaudeOffsets(ctx.home, processedOffsets);
    } else {
      await writeCodexOffsets(ctx.home, processedOffsets);
    }
  }

  return { files: files.length, envelopes: envelopeCount, bytes: byteCount };
}

function resolveRoot(
  adapter: AdapterName,
  home: string,
  env: Record<string, string | undefined>,
): string {
  if (adapter === "claude-code") return join(home, ".claude", "projects");
  const codexHome =
    env.CODEX_HOME && env.CODEX_HOME.length > 0 ? env.CODEX_HOME : join(home, ".codex");
  return join(codexHome, "sessions");
}

async function writeClaudeOffsets(home: string, offsets: Map<string, number>): Promise<void> {
  const path = join(home, ".bm-pilot", CLAUDE_OFFSETS_FILE);
  await mkdir(dirname(path), { recursive: true });
  const existing = await readJsonIfExists(path);
  const prior: Record<string, number> =
    existing && typeof existing === "object" && (existing as Record<string, unknown>).version === 1
      ? ((existing as { files?: Record<string, number> }).files ?? {})
      : {};
  const next: Record<string, number> = { ...prior };
  for (const [k, v] of offsets) next[k] = v;
  await atomicWriteJson(path, { version: 1, files: next });
}

async function writeCodexOffsets(home: string, offsets: Map<string, number>): Promise<void> {
  const path = join(home, ".bm-pilot", CODEX_OFFSETS_FILE);
  const lockPath = join(home, ".bm-pilot", CODEX_LOCK_FILE);
  await mkdir(dirname(path), { recursive: true });
  await withLock(lockPath, async () => {
    const existing = await readJsonIfExists(path);
    const container = (existing && typeof existing === "object" ? existing : {}) as Record<
      string,
      unknown
    >;
    const ns = (container.codex ?? {}) as Record<string, number>;
    const next: Record<string, number> = { ...ns };
    for (const [k, v] of offsets) next[k] = v;
    container.codex = next;
    await atomicWriteJson(path, container);
  });
}

async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (isNotFound(err)) return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

async function withLock(lockPath: string, fn: () => Promise<void>): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 500;
  let acquired = false;
  while (!acquired) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
      acquired = true;
    } catch (err) {
      if (!isEexist(err)) throw err;
      if (Date.now() > deadline) {
        if (isStaleLock(lockPath)) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
        throw new Error(`failed to acquire codex offsets lock at ${lockPath}`);
      }
      await sleep(5 + Math.floor(Math.random() * 15));
    }
  }
  try {
    await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

function isStaleLock(path: string): boolean {
  try {
    const s = statSync(path);
    return Date.now() - s.mtimeMs > 10_000;
  } catch {
    return true;
  }
}

async function safeStatSize(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.size;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseSince(input: string | undefined, now: Date): number {
  const raw = (input ?? "30d").trim().toLowerCase();
  if (raw === "all" || raw === "0") return 0;
  const m = raw.match(/^(\d+)\s*(ms|s|m|h|d)$/);
  if (!m?.[1] || !m[2]) {
    throw new Error(`invalid --since value: ${input}`);
  }
  const n = Number.parseInt(m[1], 10);
  const unit = m[2];
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
  return now.getTime() - n * multiplier;
}

async function detectDaemonRunning(home: string): Promise<boolean> {
  const pidPath = join(home, ".bm-pilot", "daemon.pid");
  if (!existsSync(pidPath)) return false;
  try {
    const raw = (await readFile(pidPath, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

function emitSummary(
  summary: BackfillSummary,
  opts: BackfillOptions,
  log: (m: string) => void,
): void {
  if (opts.json) {
    log(JSON.stringify(summary, null, 2));
    return;
  }
  log(opts.dryRun ? "backfill dry-run" : "backfill complete");
  if (summary.claude_code) {
    log(
      `  claude-code: ${fmt(summary.claude_code.files)} files  ·  ${fmt(
        summary.claude_code.envelopes,
      )} envelopes  ·  ${humanBytes(summary.claude_code.bytes)} ${
        opts.dryRun ? "would upload" : "uploaded"
      }`,
    );
  }
  if (summary.codex) {
    log(
      `  codex:       ${fmt(summary.codex.files)} files  ·  ${fmt(
        summary.codex.envelopes,
      )} envelopes  ·  ${humanBytes(summary.codex.bytes)} ${
        opts.dryRun ? "would upload" : "uploaded"
      }`,
    );
  }
  log("  cursor:      skipped (no historical record)");
  if (!opts.dryRun) log("offsets advanced to EOF for all processed files.");
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function emptySummary(): BackfillSummary {
  return { cursor: { skipped: true, reason: "no historical record" } };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isNotFound(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT",
  );
}

function isEexist(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code: string }).code === "EEXIST",
  );
}

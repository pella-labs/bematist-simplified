import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EventEnvelope } from "@bematist/contracts";
import type { EmitFn } from "../types";
import type {
  CodexMessageRecord,
  CodexRecord,
  CodexSessionMetaRecord,
  CodexToolCallRecord,
  CodexToolResultRecord,
  CodexTurnContextRecord,
} from "./parseRollout";
import { parseRolloutLine } from "./parseRollout";
import { TokenDiffer } from "./tokenDiff";

const SOURCE_VERSION_DEFAULT = "codex-cli";

export interface CodexTailerOptions {
  emit: EmitFn;
  clientVersion: string;
  sessionsDir?: string;
  offsetsPath?: string;
  offsetsLockPath?: string;
  pollIntervalMs?: number;
  watch?: boolean;
  platform?: NodeJS.Platform;
  runGit?: (cwd: string) => Promise<string | null>;
  log?: (msg: string) => void;
  clock?: {
    setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearInterval: (t: ReturnType<typeof setInterval>) => void;
  };
  nowIso?: () => string;
}

interface FileState {
  path: string;
  sessionId: string;
  sourceSessionId: string | null;
  eventSeq: number;
  cwd: string | null;
  branch: string | null;
  gitSha: string | null;
  activeModel: string | null;
  offset: number;
  differ: TokenDiffer;
  lastAssistantSeq: number | null;
  lastAssistantTurn: string | null;
  sessionStartEmitted: boolean;
}

const OFFSET_NAMESPACE = "codex";

export function defaultSessionsDir(): string {
  const base = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(base, "sessions");
}

export function defaultOffsetsPath(): string {
  return join(homedir(), ".bm-pilot", "offsets-codex.json");
}

export function defaultOffsetsLockPath(): string {
  return join(homedir(), ".bm-pilot", "offsets-codex.lock");
}

export class CodexTailer {
  private readonly opts: Required<
    Omit<CodexTailerOptions, "runGit" | "clock" | "watch" | "platform" | "log" | "nowIso">
  > & {
    runGit: (cwd: string) => Promise<string | null>;
    watch: boolean;
    platform: NodeJS.Platform;
    log: (msg: string) => void;
    nowIso: () => string;
    clock: NonNullable<CodexTailerOptions["clock"]>;
  };
  private readonly states = new Map<string, FileState>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private pollChain: Promise<void> = Promise.resolve();

  constructor(options: CodexTailerOptions) {
    const clock = options.clock ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (t) => clearInterval(t),
    };
    this.opts = {
      emit: options.emit,
      clientVersion: options.clientVersion,
      sessionsDir: options.sessionsDir ?? defaultSessionsDir(),
      offsetsPath: options.offsetsPath ?? defaultOffsetsPath(),
      offsetsLockPath: options.offsetsLockPath ?? defaultOffsetsLockPath(),
      pollIntervalMs: options.pollIntervalMs ?? 1000,
      watch: options.watch ?? true,
      platform: options.platform ?? process.platform,
      runGit: options.runGit ?? defaultRunGit,
      log: options.log ?? ((msg) => console.log(msg)),
      nowIso: options.nowIso ?? (() => new Date().toISOString()),
      clock,
    };
  }

  async start(): Promise<void> {
    await this.loadOffsets();
    await this.poll();
    if (!this.opts.watch) return;
    this.interval = this.opts.clock.setInterval(() => {
      this.pollChain = this.pollChain.then(() => this.poll()).catch(() => undefined);
    }, this.opts.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval) {
      this.opts.clock.clearInterval(this.interval);
      this.interval = null;
    }
    await this.pollChain.catch(() => undefined);
  }

  async poll(): Promise<void> {
    if (this.stopped) return;
    const files = await findRolloutFiles(this.opts.sessionsDir);
    for (const path of files) {
      if (this.stopped) return;
      try {
        await this.pollOne(path);
      } catch (err) {
        this.opts.log(`[codex] poll error on ${path}: ${errMessage(err)}`);
      }
    }
    if (this.states.size > 0) {
      await this.persistOffsets();
    }
  }

  private async pollOne(path: string): Promise<void> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return;
    }
    let state = this.states.get(path);
    const savedOffset = state ? state.offset : this.pendingOffsets.get(path);
    const isFirstVisit = state === undefined;
    if (isFirstVisit) {
      const startOffset = savedOffset !== undefined ? savedOffset : size;
      state = {
        path,
        sessionId: randomUUID(),
        sourceSessionId: null,
        eventSeq: 0,
        cwd: null,
        branch: null,
        gitSha: null,
        activeModel: null,
        offset: startOffset,
        differ: new TokenDiffer(),
        lastAssistantSeq: null,
        lastAssistantTurn: null,
        sessionStartEmitted: false,
      };
      this.states.set(path, state);
    }
    if (!state) return;
    if (state.offset > size) {
      state.offset = 0;
      state.differ.reset();
    }
    if (state.offset >= size) return;

    const { lines, nextOffset } = await readLinesFromOffset(path, state.offset);
    for (const raw of lines) {
      const outcome = parseRolloutLine(raw);
      if (!outcome.record) continue;
      await this.handleRecord(state, outcome.record);
    }
    state.offset = nextOffset;
  }

  private async handleRecord(state: FileState, record: CodexRecord): Promise<void> {
    switch (record.kind) {
      case "session_meta":
        await this.onSessionMeta(state, record);
        break;
      case "turn_context":
        this.onTurnContext(state, record);
        break;
      case "user_message":
      case "assistant_message":
        this.onMessage(state, record);
        break;
      case "tool_call":
        this.onToolCall(state, record);
        break;
      case "tool_result":
        this.onToolResult(state, record);
        break;
      case "token_count":
        this.onTokenCount(state, record);
        break;
      case "session_end":
        this.onSessionEnd(state, record);
        break;
    }
  }

  private async onSessionMeta(state: FileState, record: CodexSessionMetaRecord): Promise<void> {
    state.sourceSessionId = record.source_session_id ?? sessionIdFromPath(state.path);
    state.cwd = record.cwd;
    if (record.model) state.activeModel = record.model;
    state.differ.reset();
    if (this.opts.platform === "win32" && state.cwd) {
      try {
        const sha = await this.opts.runGit(state.cwd);
        if (sha) state.gitSha = sha;
      } catch (err) {
        this.opts.log(`[codex] git sha fallback failed: ${errMessage(err)}`);
      }
    }
    const env = this.buildEnvelope(
      state,
      record.timestamp,
      "session_start",
      {
        kind: "session_start",
        source_session_id: state.sourceSessionId,
      },
      record.raw,
    );
    this.opts.emit(env);
    state.sessionStartEmitted = true;
  }

  private onTurnContext(state: FileState, record: CodexTurnContextRecord): void {
    if (record.cwd) state.cwd = record.cwd;
    if (record.model) state.activeModel = record.model;
  }

  private onMessage(state: FileState, record: CodexMessageRecord): void {
    this.ensureSession(state, record.timestamp);
    if (record.role === "user") {
      const env = this.buildEnvelope(
        state,
        record.timestamp,
        "user_prompt",
        {
          kind: "user_prompt",
          text: record.text,
        },
        record.raw,
      );
      this.opts.emit(env);
      return;
    }
    const usedModel = record.model ?? state.activeModel;
    if (usedModel) state.activeModel = usedModel;
    const env = this.buildEnvelope(
      state,
      record.timestamp,
      "assistant_response",
      {
        kind: "assistant_response",
        text: record.text,
        stop_reason: record.stop_reason,
      },
      record.raw,
    );
    const seq = env.event_seq;
    this.opts.emit(env);
    state.lastAssistantSeq = seq;
    state.lastAssistantTurn = record.turn_id;
  }

  private onToolCall(state: FileState, record: CodexToolCallRecord): void {
    this.ensureSession(state, record.timestamp);
    const env = this.buildEnvelope(
      state,
      record.timestamp,
      "tool_call",
      {
        kind: "tool_call",
        tool_name: record.tool_name,
        tool_input: record.tool_input,
        tool_use_id: record.tool_use_id,
      },
      record.raw,
    );
    this.opts.emit(env);
  }

  private onToolResult(state: FileState, record: CodexToolResultRecord): void {
    this.ensureSession(state, record.timestamp);
    const env = this.buildEnvelope(
      state,
      record.timestamp,
      "tool_result",
      {
        kind: "tool_result",
        tool_name: record.tool_name,
        tool_output: record.tool_output,
        tool_use_id: record.tool_use_id,
        is_error: record.is_error,
      },
      record.raw,
    );
    this.opts.emit(env);
  }

  private onTokenCount(state: FileState, record: CodexRecord & { kind: "token_count" }): void {
    this.ensureSession(state, record.timestamp);
    const { delta } = state.differ.observe(record.cumulative);
    if (
      delta.input_tokens === 0 &&
      delta.output_tokens === 0 &&
      delta.cached_input_tokens === 0 &&
      delta.total_tokens === 0
    ) {
      return;
    }
    const usage = {
      input_tokens: delta.input_tokens,
      output_tokens: delta.output_tokens,
      cache_read_tokens: delta.cached_input_tokens,
      cache_creation_tokens: 0,
    };
    const model = record.model ?? state.activeModel;
    if (state.lastAssistantSeq !== null && state.lastAssistantTurn === record.turn_id) {
      const env = this.buildEnvelope(
        state,
        record.timestamp,
        "assistant_response",
        {
          kind: "assistant_response",
          text: "",
          stop_reason: "token_count",
        },
        record.raw,
      );
      env.usage = usage;
      if (model) env.model = model;
      this.opts.emit(env);
      state.lastAssistantSeq = null;
      state.lastAssistantTurn = null;
      return;
    }
    const env = this.buildEnvelope(
      state,
      record.timestamp,
      "assistant_response",
      {
        kind: "assistant_response",
        text: "",
        stop_reason: "token_count",
      },
      record.raw,
    );
    env.usage = usage;
    if (model) env.model = model;
    this.opts.emit(env);
  }

  private onSessionEnd(state: FileState, record: CodexRecord & { kind: "session_end" }): void {
    if (!state.sessionStartEmitted) return;
    const env = this.buildEnvelope(
      state,
      record.timestamp,
      "session_end",
      {
        kind: "session_end",
        source_session_id: state.sourceSessionId ?? sessionIdFromPath(state.path),
        reason: "session_end",
      },
      record.raw,
    );
    this.opts.emit(env);
  }

  private ensureSession(state: FileState, timestamp: string | null): void {
    if (state.sessionStartEmitted) return;
    state.sourceSessionId = state.sourceSessionId ?? sessionIdFromPath(state.path);
    const env = this.buildEnvelope(
      state,
      timestamp,
      "session_start",
      {
        kind: "session_start",
        source_session_id: state.sourceSessionId,
      },
      { synthesized: true },
    );
    this.opts.emit(env);
    state.sessionStartEmitted = true;
  }

  private buildEnvelope(
    state: FileState,
    timestamp: string | null,
    kind: EventEnvelope["kind"],
    payload: EventEnvelope["payload"],
    raw: unknown,
  ): EventEnvelope {
    const seq = state.eventSeq++;
    const env: EventEnvelope = {
      client_event_id: randomUUID(),
      schema_version: 1,
      session_id: state.sessionId,
      source_session_id: state.sourceSessionId ?? sessionIdFromPath(state.path),
      source: "codex",
      source_version: SOURCE_VERSION_DEFAULT,
      client_version: this.opts.clientVersion,
      ts: normalizeTs(timestamp) ?? this.opts.nowIso(),
      event_seq: seq,
      kind,
      payload,
      cwd: state.cwd,
      git_branch: state.branch,
      git_sha: state.gitSha,
      model: state.activeModel,
      usage: null,
      duration_ms: null,
      success: null,
      raw,
    };
    return env;
  }

  // --- offsets persistence (shared with Claude Code via ~/.bm-pilot/offsets.json) ---

  private pendingOffsets = new Map<string, number>();

  private async loadOffsets(): Promise<void> {
    const file = await readJsonIfExists(this.opts.offsetsPath);
    if (!file || typeof file !== "object") return;
    const ns = (file as Record<string, unknown>)[OFFSET_NAMESPACE];
    if (!ns || typeof ns !== "object") return;
    for (const [k, v] of Object.entries(ns as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        this.pendingOffsets.set(k, v);
      }
    }
  }

  private async persistOffsets(): Promise<void> {
    await withLock(this.opts.offsetsLockPath, async () => {
      const file = (await readJsonIfExists(this.opts.offsetsPath)) ?? {};
      const container = (typeof file === "object" && file !== null ? file : {}) as Record<
        string,
        unknown
      >;
      const ns = (container[OFFSET_NAMESPACE] ?? {}) as Record<string, number>;
      const nextNs: Record<string, number> = { ...ns };
      for (const [path, state] of this.states.entries()) {
        nextNs[path] = state.offset;
      }
      container[OFFSET_NAMESPACE] = nextNs;
      await atomicWriteJson(this.opts.offsetsPath, container);
    });
  }
}

async function findRolloutFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as unknown as Array<{
        name: string;
        isDirectory(): boolean;
        isFile(): boolean;
      }>;
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        out.push(p);
      }
    }
  }
  await walk(root);
  return out;
}

export async function readLinesFromOffset(
  path: string,
  offset: number,
): Promise<{ lines: string[]; nextOffset: number }> {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { lines: [], nextOffset: offset };
  }
  if (offset >= size) return { lines: [], nextOffset: offset };
  const fh = await open(path, "r");
  try {
    const CHUNK = 64 * 1024;
    const buf = Buffer.alloc(CHUNK);
    let pos = offset;
    let residual = "";
    const lines: string[] = [];
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
      if (bytesRead === 0) break;
      const chunk = residual + buf.toString("utf8", 0, bytesRead);
      const parts = chunk.split("\n");
      residual = parts.pop() ?? "";
      for (const p of parts) {
        if (p.length > 0) lines.push(p);
      }
      pos += bytesRead;
    }
    const residualBytes = Buffer.byteLength(residual, "utf8");
    return { lines, nextOffset: size - residualBytes };
  } finally {
    await fh.close();
  }
}

function sessionIdFromPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  const m = name.match(/^rollout-([A-Za-z0-9_-]+)\.jsonl$/);
  if (m?.[1]) return m[1];
  return name.replace(/\.jsonl$/, "");
}

function normalizeTs(ts: string | null): string | null {
  if (!ts) return null;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
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
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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
        if (isStale(lockPath)) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
        throw new Error(`[codex] failed to acquire offsets lock at ${lockPath}`);
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

function isStale(lockPath: string): boolean {
  try {
    const s = statSync(lockPath);
    return Date.now() - s.mtimeMs > 10_000;
  } catch {
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function defaultRunGit(cwd: string): Promise<string | null> {
  if (!existsSync(cwd)) return null;
  const proc = Bun.spawn({
    cmd: ["git", "-C", cwd, "rev-parse", "HEAD"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) return null;
  const sha = text.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

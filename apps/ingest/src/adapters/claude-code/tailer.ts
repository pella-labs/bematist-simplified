import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EventEnvelope } from "@bematist/contracts";
import type { EmitFn } from "../types";
import {
  makeSessionEndEnvelope,
  makeSessionStartEnvelope,
  type ParseContext,
  parseLineToEnvelopes,
  SOURCE_VERSION,
} from "./parseSessionFile";

const DEDUP_MAX = 10_000;
const GIT_SHA_QUEUE_SUBDIR = "git-sha-queue";
const OFFSETS_FILE = "offsets.json";
const BOM_UTF8 = "\uFEFF";

export interface TailerOptions {
  projectsDir: string;
  stateDir: string;
  clientVersion: string;
  emit: EmitFn;
  pollIntervalMs?: number;
  log?: (msg: string) => void;
}

interface FileState {
  path: string;
  offset: number;
  clientSessionId: string;
  sourceSessionId: string | null;
  seq: number;
  dedup: LruSet;
  sourceVersion: string;
  cwd: string | null;
  gitBranch: string | null;
  emittedStart: boolean;
  lastSeenSize: number;
  inode: number | null;
}

export interface Tailer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Test helper: force a single scan pass. */
  tick(): Promise<void>;
}

interface OffsetsFile {
  version: 1;
  files: Record<string, number>;
}

export function createTailer(opts: TailerOptions): Tailer {
  const pollInterval = Math.max(50, opts.pollIntervalMs ?? 500);
  const log = opts.log ?? (() => {});
  const states = new Map<string, FileState>();
  const gitShaBySession = new Map<string, string>();
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let watcher: ReturnType<typeof watch> | null = null;
  let offsetsPath: string;
  let queueDir: string;
  let scanning = false;

  async function loadOffsets(): Promise<Record<string, number>> {
    try {
      const raw = await readFile(offsetsPath, "utf8");
      const parsed = JSON.parse(raw) as OffsetsFile;
      if (parsed && parsed.version === 1 && typeof parsed.files === "object") {
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed.files)) {
          if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
        }
        return out;
      }
    } catch (err) {
      if (!isNotFound(err)) log(`claude-code: failed to read offsets: ${errMsg(err)}`);
    }
    return {};
  }

  async function persistOffsets(): Promise<void> {
    const files: Record<string, number> = {};
    for (const [path, state] of states) files[path] = state.offset;
    const payload: OffsetsFile = { version: 1, files };
    await mkdir(dirname(offsetsPath), { recursive: true });
    const tmp = `${offsetsPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(tmp, offsetsPath);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async function discover(initial: boolean): Promise<string[]> {
    const out: string[] = [];
    await walk(opts.projectsDir, out);
    if (initial) log(`claude-code: discovered ${out.length} jsonl files`);
    return out;
  }

  function makeFileState(path: string, offset: number, inode: number | null): FileState {
    return {
      path,
      offset,
      clientSessionId: randomUUID(),
      sourceSessionId: null,
      seq: 0,
      dedup: new LruSet(DEDUP_MAX),
      sourceVersion: SOURCE_VERSION,
      cwd: null,
      gitBranch: null,
      emittedStart: false,
      lastSeenSize: offset,
      inode,
    };
  }

  async function initState(
    path: string,
    persistedOffset: number | undefined,
    tailFromEnd: boolean,
  ): Promise<void> {
    let st: { size: number; ino: number };
    try {
      const s = await stat(path);
      st = { size: s.size, ino: Number(s.ino) };
    } catch {
      return;
    }
    const size = st.size;
    const inode = Number.isFinite(st.ino) ? st.ino : null;
    let startOffset: number;
    let emittedStart: boolean;
    if (persistedOffset !== undefined) {
      startOffset = Math.min(persistedOffset, size);
      emittedStart = true;
    } else if (tailFromEnd && size > 0) {
      // Pre-existing file at daemon start with content — skip history.
      startOffset = size;
      emittedStart = true;
    } else {
      // New (or empty) file appeared — read from 0, emit session_start once
      // the first record arrives so we know its sourceSessionId.
      startOffset = 0;
      emittedStart = false;
    }
    const state = makeFileState(path, startOffset, inode);
    state.lastSeenSize = size;
    state.emittedStart = emittedStart;
    states.set(path, state);
  }

  async function loadGitShaQueue(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(queueDir);
    } catch (err) {
      if (isNotFound(err)) return;
      log(`claude-code: git-sha-queue read failed: ${errMsg(err)}`);
      return;
    }
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const path = join(queueDir, name);
      try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw) as {
          sessionId?: string;
          sha?: string;
        };
        if (typeof parsed?.sessionId === "string" && typeof parsed?.sha === "string") {
          gitShaBySession.set(parsed.sessionId, parsed.sha);
        }
      } catch (err) {
        log(`claude-code: git-sha queue entry parse failed (${name}): ${errMsg(err)}`);
      }
    }
  }

  async function processFile(state: FileState): Promise<EventEnvelope[]> {
    const envelopes: EventEnvelope[] = [];
    let st: { size: number; ino: number };
    try {
      const s = await stat(state.path);
      st = { size: s.size, ino: Number(s.ino) };
    } catch {
      // File vanished — drop state.
      states.delete(state.path);
      return envelopes;
    }
    const inodeChanged = state.inode !== null && Number.isFinite(st.ino) && st.ino !== state.inode;
    const shrank = st.size < state.offset;
    if (inodeChanged || shrank) {
      if (state.sourceSessionId) {
        envelopes.push(
          makeSessionEndEnvelope({
            clientSessionId: state.clientSessionId,
            sourceSessionId: state.sourceSessionId,
            clientVersion: opts.clientVersion,
            cwd: state.cwd,
            gitBranch: state.gitBranch,
            gitSha: gitShaBySession.get(state.sourceSessionId) ?? null,
            sourceVersion: state.sourceVersion,
            ts: new Date().toISOString(),
            seq: state.seq++,
            reason: inodeChanged ? "rotation" : "truncation",
          }),
        );
      }
      const reset = makeFileState(state.path, 0, Number.isFinite(st.ino) ? st.ino : null);
      reset.emittedStart = false;
      states.set(state.path, reset);
      state = reset;
    }
    state.inode = Number.isFinite(st.ino) ? st.ino : state.inode;
    state.lastSeenSize = st.size;
    if (st.size === state.offset) return envelopes;

    const { lines, nextOffset } = await readLinesFromOffset(state.path, state.offset, st.size);
    state.offset = nextOffset;
    if (lines.length === 0) return envelopes;

    const parseCtx: ParseContext = {
      clientSessionId: state.clientSessionId,
      clientVersion: opts.clientVersion,
      nextSeq: () => state.seq++,
      isDuplicate: (uuid) => !state.dedup.add(uuid),
      gitSha: () =>
        state.sourceSessionId ? (gitShaBySession.get(state.sourceSessionId) ?? null) : null,
    };

    for (const line of lines) {
      const parsed = peekRawLine(line);
      // Refresh per-state metadata from the first line that carries it.
      if (parsed) {
        if (!state.sourceSessionId && typeof parsed.sessionId === "string") {
          state.sourceSessionId = parsed.sessionId;
        }
        if (!state.cwd && typeof parsed.cwd === "string") state.cwd = parsed.cwd;
        if (!state.gitBranch && typeof parsed.gitBranch === "string") {
          state.gitBranch = parsed.gitBranch;
        }
        if (typeof parsed.version === "string") state.sourceVersion = parsed.version;
      }
      if (!state.emittedStart && state.sourceSessionId) {
        envelopes.push(
          makeSessionStartEnvelope({
            clientSessionId: state.clientSessionId,
            sourceSessionId: state.sourceSessionId,
            clientVersion: opts.clientVersion,
            cwd: state.cwd,
            gitBranch: state.gitBranch,
            gitSha: gitShaBySession.get(state.sourceSessionId) ?? null,
            sourceVersion: state.sourceVersion,
            ts: new Date().toISOString(),
            seq: state.seq++,
          }),
        );
        state.emittedStart = true;
      }
      const emitted = parseLineToEnvelopes(line, parseCtx);
      for (const ev of emitted) envelopes.push(ev);
    }
    return envelopes;
  }

  async function scanOnce(): Promise<void> {
    if (scanning) return;
    scanning = true;
    try {
      await loadGitShaQueue();
      const files = await discover(false);
      for (const path of files) {
        if (!states.has(path)) await initState(path, undefined, false);
      }
      const all: EventEnvelope[] = [];
      for (const state of [...states.values()]) {
        const emitted = await processFile(state);
        for (const e of emitted) all.push(e);
      }
      for (const e of all) opts.emit(e);
      if (all.length > 0)
        await persistOffsets().catch((err) => {
          log(`claude-code: persistOffsets failed: ${errMsg(err)}`);
        });
    } catch (err) {
      log(`claude-code: scan error: ${errMsg(err)}`);
    } finally {
      scanning = false;
    }
  }

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      offsetsPath = join(opts.stateDir, OFFSETS_FILE);
      queueDir = join(opts.stateDir, GIT_SHA_QUEUE_SUBDIR);
      await mkdir(opts.stateDir, { recursive: true });
      await mkdir(queueDir, { recursive: true });

      const persisted = await loadOffsets();
      const files = await discover(true);
      for (const path of files) await initState(path, persisted[path], true);
      // For files present in persisted but no longer on disk, forget them.

      try {
        await mkdir(opts.projectsDir, { recursive: true });
        watcher = watch(opts.projectsDir, { recursive: true }, () => {
          void scanOnce();
        });
        watcher.on?.("error", (err) => log(`claude-code: watch error: ${errMsg(err)}`));
      } catch (err) {
        log(`claude-code: watch setup failed: ${errMsg(err)}`);
      }
      await scanOnce();
      timer = setInterval(() => {
        void scanOnce();
      }, pollInterval);
    },
    async stop(): Promise<void> {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      await scanOnce();
    },
    async tick(): Promise<void> {
      await scanOnce();
    },
  };
}

class LruSet {
  private readonly cap: number;
  private readonly map = new Map<string, true>();
  constructor(cap: number) {
    this.cap = cap;
  }
  add(key: string): boolean {
    if (this.map.has(key)) {
      this.map.delete(key);
      this.map.set(key, true);
      return false;
    }
    this.map.set(key, true);
    if (this.map.size > this.cap) {
      const first = this.map.keys().next().value;
      if (first) this.map.delete(first);
    }
    return true;
  }
}

async function walk(root: string, out: string[]): Promise<void> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = (await readdir(root, { withFileTypes: true })) as unknown as Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      await walk(p, out);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push(p);
    }
  }
}

interface RawPeek {
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
}

function peekRawLine(raw: string): RawPeek | null {
  try {
    return JSON.parse(raw) as RawPeek;
  } catch {
    return null;
  }
}

async function readLinesFromOffset(
  path: string,
  offset: number,
  size: number,
): Promise<{ lines: string[]; nextOffset: number }> {
  if (offset >= size) return { lines: [], nextOffset: offset };
  const fh = await open(path, "r");
  try {
    const want = size - offset;
    const buf = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const { bytesRead } = await fh.read(buf, read, want - read, offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    let start = 0;
    if (offset === 0 && read >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      start = 3;
    }
    const lines: string[] = [];
    let lastNewlineEndByte = 0;
    let lineStart = start;
    for (let i = start; i < read; i++) {
      if (buf[i] === 0x0a) {
        let end = i;
        if (end > lineStart && buf[end - 1] === 0x0d) end--;
        if (end > lineStart) {
          let segment = buf.toString("utf8", lineStart, end);
          if (segment.startsWith(BOM_UTF8)) segment = segment.slice(1);
          lines.push(segment);
        }
        lineStart = i + 1;
        lastNewlineEndByte = i + 1;
      }
    }
    // nextOffset advances only past fully terminated lines; partial tail stays.
    return { lines, nextOffset: offset + lastNewlineEndByte };
  } finally {
    await fh.close();
  }
}

function isNotFound(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT",
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

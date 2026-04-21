import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { EventEnvelope } from "@bematist/contracts";
import type { AdapterContext } from "../types";
import {
  makeSessionEndEnvelope,
  makeSessionStartEnvelope,
  type ParseContext,
  parseLineToEnvelopes,
  SOURCE_VERSION,
} from "./parseSessionFile";

export interface HistoricalFile {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface EnumerateOptions {
  root: string;
  sinceMs: number;
}

export async function enumerateHistoricalFiles(opts: EnumerateOptions): Promise<HistoricalFile[]> {
  const out: HistoricalFile[] = [];
  await walk(opts.root, opts.sinceMs, out);
  return out;
}

async function walk(dir: string, sinceMs: number, out: HistoricalFile[]): Promise<void> {
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
    if (e.isDirectory()) {
      await walk(p, sinceMs, out);
      continue;
    }
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    try {
      const s = await stat(p);
      if (s.mtimeMs < sinceMs) continue;
      out.push({ path: p, mtimeMs: s.mtimeMs, sizeBytes: s.size });
    } catch {
      // unreadable file — skip
    }
  }
}

export async function* readFileToEnvelopes(
  path: string,
  ctx: AdapterContext,
): AsyncIterable<EventEnvelope> {
  const clientSessionId = randomUUID();
  let seq = 0;
  const seen = new Set<string>();

  let sourceSessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let sourceVersion: string = SOURCE_VERSION;
  let emittedStart = false;
  let emittedAny = false;

  const parseCtx: ParseContext = {
    clientSessionId,
    clientVersion: ctx.clientVersion,
    nextSeq: () => seq++,
    isDuplicate: (uuid) => {
      if (seen.has(uuid)) return true;
      seen.add(uuid);
      return false;
    },
    gitSha: () => null,
  };

  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    for await (const rawLine of rl) {
      const line = stripBom(rawLine);
      if (line.length === 0) continue;
      emittedAny = true;

      const peeked = peekRawLine(line);
      if (peeked) {
        if (!sourceSessionId && typeof peeked.sessionId === "string") {
          sourceSessionId = peeked.sessionId;
        }
        if (!cwd && typeof peeked.cwd === "string") cwd = peeked.cwd;
        if (!gitBranch && typeof peeked.gitBranch === "string") gitBranch = peeked.gitBranch;
        if (typeof peeked.version === "string") sourceVersion = peeked.version;
      }

      if (!emittedStart && sourceSessionId) {
        yield makeSessionStartEnvelope({
          clientSessionId,
          sourceSessionId,
          clientVersion: ctx.clientVersion,
          cwd,
          gitBranch,
          gitSha: null,
          sourceVersion,
          ts: new Date().toISOString(),
          seq: seq++,
        });
        emittedStart = true;
      }

      const envelopes = parseLineToEnvelopes(line, parseCtx);
      for (const env of envelopes) yield env;
    }
  } finally {
    rl.close();
    stream.close();
  }

  if (emittedAny && emittedStart && sourceSessionId) {
    yield makeSessionEndEnvelope({
      clientSessionId,
      sourceSessionId,
      clientVersion: ctx.clientVersion,
      cwd,
      gitBranch,
      gitSha: null,
      sourceVersion,
      ts: new Date().toISOString(),
      seq: seq++,
      reason: "backfill",
    });
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

function stripBom(s: string): string {
  if (s.length > 0 && s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}

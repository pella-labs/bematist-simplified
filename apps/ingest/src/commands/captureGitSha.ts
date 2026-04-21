import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CaptureGitShaOptions {
  /** Raw stdin JSON text the hook was invoked with. */
  stdin: string;
  /** Test seam: override the ingest state directory. Defaults to ~/.bm-pilot. */
  stateDir?: string;
  /** Test seam: override git sha resolver. Default runs `git -C <cwd> rev-parse HEAD`. */
  resolveSha?: (cwd: string) => Promise<string | null>;
  /** Test seam: override branch resolver. */
  resolveBranch?: (cwd: string) => Promise<string | null>;
  /** Test seam: override clock. */
  now?: () => Date;
}

export interface CaptureGitShaResult {
  wrote: boolean;
  path: string | null;
  reason: "ok" | "no-session-id" | "no-cwd" | "no-sha" | "malformed-stdin";
}

export async function captureGitSha(opts: CaptureGitShaOptions): Promise<CaptureGitShaResult> {
  let input: { session_id?: unknown; cwd?: unknown; hook_event_name?: unknown } | null;
  try {
    input = opts.stdin.trim() ? JSON.parse(opts.stdin) : null;
  } catch {
    return { wrote: false, path: null, reason: "malformed-stdin" };
  }
  if (!input || typeof input !== "object") {
    return { wrote: false, path: null, reason: "malformed-stdin" };
  }
  const sessionId = typeof input.session_id === "string" ? input.session_id : null;
  const cwd = typeof input.cwd === "string" ? input.cwd : null;
  if (!sessionId) return { wrote: false, path: null, reason: "no-session-id" };
  if (!cwd) return { wrote: false, path: null, reason: "no-cwd" };

  const resolveSha = opts.resolveSha ?? defaultResolveSha;
  const resolveBranch = opts.resolveBranch ?? defaultResolveBranch;
  const sha = await resolveSha(cwd);
  if (!sha) return { wrote: false, path: null, reason: "no-sha" };
  const branch = await resolveBranch(cwd);
  const capturedAt = (opts.now ?? (() => new Date()))().toISOString();

  const stateDir = opts.stateDir ?? defaultStateDir();
  const queueDir = join(stateDir, "git-sha-queue");
  await mkdir(queueDir, { recursive: true });
  const safe = safeName(sessionId);
  const path = join(queueDir, `${safe}.json`);
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(
      tmp,
      `${JSON.stringify({ sessionId, cwd, sha, branch, capturedAt }, null, 2)}\n`,
      { mode: 0o600, flag: "w" },
    );
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return { wrote: true, path, reason: "ok" };
}

function defaultStateDir(): string {
  return join(homedir(), ".bm-pilot");
}

function safeName(sessionId: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(sessionId) && sessionId.length <= 128) return sessionId;
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

async function defaultResolveSha(cwd: string): Promise<string | null> {
  try {
    const p = Bun.spawn({
      cmd: ["git", "-C", cwd, "rev-parse", "HEAD"],
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(p.stdout).text();
    const code = await p.exited;
    if (code !== 0) return null;
    const sha = text.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

async function defaultResolveBranch(cwd: string): Promise<string | null> {
  try {
    const p = Bun.spawn({
      cmd: ["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(p.stdout).text();
    const code = await p.exited;
    if (code !== 0) return null;
    const branch = text.trim();
    return branch.length > 0 && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

export { defaultStateDir };

/**
 * Synchronous-ish entry point: reads stdin to completion, runs capture, prints
 * a brief status line, and always exits 0 so a missing git repo never blocks a
 * Claude Code session from starting.
 */
export async function runCaptureGitShaCli(
  io: {
    stdin: NodeJS.ReadStream | ReadableStream<Uint8Array>;
    stdout: { write(chunk: string): unknown };
  } = { stdin: process.stdin, stdout: process.stdout },
): Promise<number> {
  const text = await readAll(io.stdin);
  const res = await captureGitSha({ stdin: text });
  io.stdout.write(`${JSON.stringify({ "bm-pilot": "capture-git-sha", ...res })}\n`);
  return 0;
}

async function readAll(stream: NodeJS.ReadStream | ReadableStream<Uint8Array>): Promise<string> {
  if ("getReader" in stream) {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parts.push(value);
    }
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return new TextDecoder().decode(out);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export { dirname };

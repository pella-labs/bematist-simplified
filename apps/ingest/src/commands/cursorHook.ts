import { appendFile, mkdir } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultCursorSocketAddress } from "../adapters/cursor/socket";

export interface CursorHookIO {
  argv: string[];
  stdin: NodeJS.ReadableStream;
  socketAddress?: string;
  errorLogPath?: string;
  timeoutMs?: number;
  now?: () => string;
}

const DEFAULT_TIMEOUT_MS = 250;

export async function runCursorHook(io: CursorHookIO): Promise<number> {
  const timeoutMs = io.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socketAddress = io.socketAddress ?? defaultCursorSocketAddress();
  const errorLogPath = io.errorLogPath ?? defaultErrorLogPath();
  const now = io.now ?? (() => new Date().toISOString());

  try {
    const eventName = io.argv[3];
    const stdinText = await readStdinWithTimeout(io.stdin, timeoutMs);
    const payload = buildPayload(stdinText, eventName);
    await sendToSocket(socketAddress, payload, timeoutMs);
    return 0;
  } catch (err) {
    await logError(errorLogPath, now(), err).catch(() => {});
    return 0;
  }
}

function buildPayload(stdinText: string, eventName: string | undefined): string {
  const trimmed = stdinText.trim();
  let obj: Record<string, unknown>;
  if (trimmed.length === 0) {
    obj = {};
  } else {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("stdin JSON must be an object");
    }
    obj = parsed as Record<string, unknown>;
  }
  if (eventName && typeof obj.hook_event_name !== "string") {
    obj.hook_event_name = eventName;
  }
  if (typeof obj.hook_event_name !== "string") {
    throw new Error("missing hook_event_name");
  }
  return `${JSON.stringify(obj)}\n`;
}

function readStdinWithTimeout(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => resolve(buf));
    }, timeoutMs);
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk: string | Buffer) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    stream.on("end", () => {
      finish(() => {
        clearTimeout(timer);
        resolve(buf);
      });
    });
    stream.on("error", (err) => {
      finish(() => {
        clearTimeout(timer);
        reject(err);
      });
    });
  });
}

function sendToSocket(address: string, line: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      try {
        client.destroy();
      } catch {}
      if (err) reject(err);
      else resolve();
    };
    const client = connect(address);
    const timer = setTimeout(() => finish(new Error("socket timeout")), timeoutMs);
    let buf = "";
    client.setEncoding("utf8");
    client.once("connect", () => {
      client.write(line);
    });
    client.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.includes("\n")) {
        clearTimeout(timer);
        finish();
      }
    });
    client.once("error", (err) => {
      clearTimeout(timer);
      finish(err);
    });
  });
}

async function logError(path: string, ts: string, err: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  await appendFile(path, `${ts} ${msg}\n`);
}

function defaultErrorLogPath(home: string = homedir()): string {
  return join(home, ".bm-pilot", "cursor-hook-errors.log");
}

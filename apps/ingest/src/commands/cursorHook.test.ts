import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { startCursorSocket } from "../adapters/cursor/socket";
import { runCursorHook } from "./cursorHook";

let dir: string;
let socketPath: string;
let errorLogPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bm-hook-"));
  socketPath = join(dir, "cursor.sock");
  errorLogPath = join(dir, "cursor-hook-errors.log");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function stdinFrom(s: string): NodeJS.ReadableStream {
  return Readable.from([s]);
}

describe("runCursorHook", () => {
  test("stdin → socket → ack round-trip with hook_event_name on stdin", async () => {
    const received: string[] = [];
    const server = await startCursorSocket({
      address: socketPath,
      handler: (raw) => {
        received.push(raw);
        return { ok: true };
      },
    });
    try {
      const code = await runCursorHook({
        argv: ["bun", "bematist", "cursor-hook"],
        stdin: stdinFrom('{"hook_event_name":"sessionStart","session_id":"s1"}'),
        socketAddress: socketPath,
        errorLogPath,
      });
      expect(code).toBe(0);
      expect(received).toHaveLength(1);
      const obj = JSON.parse(received[0]!);
      expect(obj.hook_event_name).toBe("sessionStart");
      expect(obj.session_id).toBe("s1");
    } finally {
      await server.close();
    }
  });

  test("argv event-name fallback is applied when stdin JSON lacks hook_event_name", async () => {
    const received: string[] = [];
    const server = await startCursorSocket({
      address: socketPath,
      handler: (raw) => {
        received.push(raw);
        return { ok: true };
      },
    });
    try {
      const code = await runCursorHook({
        argv: ["bun", "bematist", "cursor-hook", "beforeSubmitPrompt"],
        stdin: stdinFrom('{"session_id":"s2","prompt":"hi"}'),
        socketAddress: socketPath,
        errorLogPath,
      });
      expect(code).toBe(0);
      const obj = JSON.parse(received[0]!);
      expect(obj.hook_event_name).toBe("beforeSubmitPrompt");
      expect(obj.prompt).toBe("hi");
    } finally {
      await server.close();
    }
  });

  test("socket connect timeout does not block — exits 0 silently and logs", async () => {
    const deadSocket = join(dir, "does-not-exist.sock");
    const start = Date.now();
    const code = await runCursorHook({
      argv: ["bun", "bematist", "cursor-hook", "sessionStart"],
      stdin: stdinFrom('{"session_id":"s3"}'),
      socketAddress: deadSocket,
      errorLogPath,
      timeoutMs: 100,
    });
    const elapsed = Date.now() - start;
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(1500);
    const s = await stat(errorLogPath);
    expect(s.size).toBeGreaterThan(0);
    const content = await readFile(errorLogPath, "utf8");
    expect(content.length).toBeGreaterThan(0);
  });

  test("malformed stdin JSON → exit 0, error logged, no socket write", async () => {
    const received: string[] = [];
    const server = await startCursorSocket({
      address: socketPath,
      handler: (raw) => {
        received.push(raw);
        return { ok: true };
      },
    });
    try {
      const code = await runCursorHook({
        argv: ["bun", "bematist", "cursor-hook", "sessionStart"],
        stdin: stdinFrom("not json"),
        socketAddress: socketPath,
        errorLogPath,
      });
      expect(code).toBe(0);
      expect(received).toHaveLength(0);
      const content = await readFile(errorLogPath, "utf8");
      expect(content).toMatch(/JSON|Unexpected/);
    } finally {
      await server.close();
    }
  });
});

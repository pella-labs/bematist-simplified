import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCursorSocket } from "./socket";

let dir: string;
let addr: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bm-sock-"));
  addr = join(dir, "cursor.sock");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sendLine(address: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = connect(address);
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        resolve(buf.slice(0, idx));
        c.end();
      }
    });
    c.on("error", reject);
    c.once("connect", () => {
      c.write(line);
    });
  });
}

describe("cursor socket server", () => {
  test("accepts a connection and acks valid line", async () => {
    const server = await startCursorSocket({
      address: addr,
      handler: () => ({ ok: true }),
    });
    try {
      const reply = await sendLine(addr, '{"hook_event_name":"sessionStart"}\n');
      expect(JSON.parse(reply)).toEqual({ ok: true });
    } finally {
      await server.close();
    }
  });

  test("handles multiple concurrent connections", async () => {
    const received: string[] = [];
    const server = await startCursorSocket({
      address: addr,
      handler: (raw) => {
        received.push(raw);
        return { ok: true };
      },
    });
    try {
      const replies = await Promise.all([
        sendLine(addr, '{"n":1}\n'),
        sendLine(addr, '{"n":2}\n'),
        sendLine(addr, '{"n":3}\n'),
      ]);
      for (const r of replies) expect(JSON.parse(r)).toEqual({ ok: true });
      expect(received).toHaveLength(3);
    } finally {
      await server.close();
    }
  });

  test("handles malformed JSON gracefully — acks ok:false and keeps serving", async () => {
    const server = await startCursorSocket({
      address: addr,
      handler: (raw) => {
        JSON.parse(raw);
        return { ok: true };
      },
    });
    try {
      const bad = await sendLine(addr, "not json at all\n");
      const parsed = JSON.parse(bad);
      expect(parsed.ok).toBe(false);
      expect(typeof parsed.error).toBe("string");

      const good = await sendLine(addr, '{"ok":1}\n');
      expect(JSON.parse(good)).toEqual({ ok: true });
    } finally {
      await server.close();
    }
  });

  test("processes multiple lines in a single connection", async () => {
    const received: string[] = [];
    const server = await startCursorSocket({
      address: addr,
      handler: (raw) => {
        received.push(raw);
        return { ok: true };
      },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const c = connect(addr);
        let acks = 0;
        let buf = "";
        c.setEncoding("utf8");
        c.on("data", (chunk: string) => {
          buf += chunk;
          while (buf.includes("\n")) {
            const idx = buf.indexOf("\n");
            buf = buf.slice(idx + 1);
            acks++;
            if (acks === 2) {
              c.end();
              resolve();
            }
          }
        });
        c.on("error", reject);
        c.once("connect", () => {
          c.write('{"a":1}\n{"b":2}\n');
        });
      });
      expect(received).toEqual(['{"a":1}', '{"b":2}']);
    } finally {
      await server.close();
    }
  });

  test("close releases the socket file on unix", async () => {
    if (process.platform === "win32") return;
    const server = await startCursorSocket({
      address: addr,
      handler: () => ({ ok: true }),
    });
    await server.close();

    const server2 = await startCursorSocket({
      address: addr,
      handler: () => ({ ok: true }),
    });
    try {
      const reply = await sendLine(addr, '{"x":1}\n');
      expect(JSON.parse(reply)).toEqual({ ok: true });
    } finally {
      await server2.close();
    }
  });
});

import { mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export type SocketHandler = (raw: string) => { ok: true } | { ok: false; error: string };

export interface SocketServer {
  address: string;
  close(): Promise<void>;
}

export interface StartSocketOptions {
  address?: string;
  handler: SocketHandler;
  onError?: (err: unknown) => void;
}

export function defaultCursorSocketAddress(home: string = homedir()): string {
  if (platform() === "win32") return "\\\\?\\pipe\\bm-pilot-cursor";
  return join(home, ".bm-pilot", "cursor.sock");
}

export async function startCursorSocket(opts: StartSocketOptions): Promise<SocketServer> {
  const address = opts.address ?? defaultCursorSocketAddress();
  if (platform() !== "win32") {
    await mkdir(dirname(address), { recursive: true });
    await unlink(address).catch(() => {});
  }

  const connections = new Set<Socket>();
  const server: Server = createServer((conn: Socket) => {
    connections.add(conn);
    let buf = "";
    conn.setEncoding("utf8");
    const process = () => {
      let idx = buf.indexOf("\n");
      while (idx !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.length > 0) {
          const reply = safeHandle(line, opts.handler, opts.onError);
          conn.write(`${JSON.stringify(reply)}\n`);
        }
        idx = buf.indexOf("\n");
      }
    };
    conn.on("data", (chunk: string) => {
      buf += chunk;
      process();
    });
    conn.on("end", () => {
      if (buf.length > 0 && !buf.endsWith("\n")) buf += "\n";
      process();
      conn.end();
    });
    conn.on("close", () => {
      connections.delete(conn);
    });
    conn.on("error", (err) => {
      opts.onError?.(err);
    });
  });

  server.on("error", (err) => {
    opts.onError?.(err);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    address,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const conn of connections) {
          try {
            conn.destroy();
          } catch {}
        }
        connections.clear();
      });
      if (platform() !== "win32") {
        await unlink(address).catch(() => {});
      }
    },
  };
}

function safeHandle(
  line: string,
  handler: SocketHandler,
  onError: ((err: unknown) => void) | undefined,
): { ok: true } | { ok: false; error: string } {
  try {
    return handler(line);
  } catch (err) {
    onError?.(err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

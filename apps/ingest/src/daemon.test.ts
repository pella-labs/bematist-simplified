import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { startDaemon } from "./daemon";

let server: ReturnType<typeof Bun.serve>;
let dir: string;
let sessionPath: string;
let baseConfig: Config;

beforeEach(async () => {
  dir = join(tmpdir(), `bm-pilot-daemon-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  sessionPath = join(dir, "current-session");
  server = Bun.serve({
    port: 0,
    async fetch() {
      return new Response(JSON.stringify({ accepted: 0, deduped: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  baseConfig = {
    apiUrl: `http://localhost:${server.port}`,
    ingestKey: `bm_${randomUUID()}_${"a".repeat(16)}_${"b".repeat(32)}`,
    deviceId: randomUUID(),
    adapters: { mock: { enabled: true } },
    installedAt: new Date().toISOString(),
  };
});

afterEach(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function readSessionFile(): Promise<string | null> {
  try {
    const raw = await readFile(sessionPath, "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

describe("daemon current-session lifecycle", () => {
  test("writes current-session on session_start and clears on stop", async () => {
    const handle = await startDaemon({
      config: baseConfig,
      log: () => {},
      currentSessionPath: sessionPath,
    });
    // Let mock adapter emit its session_start events (sync in its `start`).
    // Small delay so the async write lands.
    await new Promise((r) => setTimeout(r, 50));
    const first = await readSessionFile();
    expect(first).not.toBeNull();
    expect(first?.length).toBeGreaterThan(0);

    await handle.stop();
    // Give the stop() drain a moment to unlink.
    await new Promise((r) => setTimeout(r, 20));
    await expect(access(sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

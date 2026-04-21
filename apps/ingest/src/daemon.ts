import { createClaudeCodeAdapter } from "./adapters/claude-code";
import { createCodexAdapter } from "./adapters/codex";
import { createCursorAdapter } from "./adapters/cursor";
import {
  clearCurrentSession,
  defaultCurrentSessionPath,
  writeCurrentSession,
} from "./adapters/git/currentSession";
import { createMockAdapter } from "./adapters/mock";
import type { Adapter, Stop } from "./adapters/types";
import { Batcher } from "./batcher";
import type { Config } from "./config";
import { Uploader } from "./uploader";

// Baked in at compile time via `bun build --define`. See apps/ingest/build.ts
// and .github/workflows/release.yml. Fallback is for local `bun run` during dev.
export const CLIENT_VERSION = process.env.BM_PILOT_VERSION ?? "0.0.0-dev";

export interface DaemonHandle {
  stop: Stop;
}

export interface DaemonOptions {
  config: Config;
  log?: (msg: string) => void;
  /** Test seam: override the path where the active session id is persisted. */
  currentSessionPath?: string;
}

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const { config } = opts;
  const log = opts.log ?? defaultLog;

  if (!config.ingestKey) {
    throw new Error("not logged in: run `bm-pilot login` first");
  }

  const uploader = new Uploader({
    apiUrl: config.apiUrl,
    ingestKey: config.ingestKey,
    clientVersion: CLIENT_VERSION,
  });

  const batcher = new Batcher({
    uploader,
    onFlushSuccess: ({ accepted, deduped, attempted }) => {
      log(`flushed batch: attempted=${attempted} accepted=${accepted} deduped=${deduped}`);
    },
    onFlushError: (err) => {
      log(`flush error: ${errMessage(err)}`);
    },
    onDrop: (n) => {
      log(`dropped ${n} events`);
    },
  });

  const sessionPath = opts.currentSessionPath ?? defaultCurrentSessionPath();
  const activeSessions = new Set<string>();
  let lastStampedSession: string | null = null;

  const onEvent = (event: { kind: string; session_id: string }) => {
    if (event.kind === "session_start") {
      activeSessions.add(event.session_id);
      void writeCurrentSession(event.session_id, sessionPath)
        .then(() => {
          lastStampedSession = event.session_id;
        })
        .catch((err) => log(`write current-session failed: ${errMessage(err)}`));
    } else if (event.kind === "session_end") {
      activeSessions.delete(event.session_id);
      if (activeSessions.size === 0) {
        lastStampedSession = null;
        void clearCurrentSession(sessionPath).catch((err) =>
          log(`clear current-session failed: ${errMessage(err)}`),
        );
      } else if (lastStampedSession === event.session_id) {
        const next = activeSessions.values().next().value;
        if (next) {
          void writeCurrentSession(next, sessionPath)
            .then(() => {
              lastStampedSession = next;
            })
            .catch((err) => log(`write current-session failed: ${errMessage(err)}`));
        }
      }
    }
  };

  const adapters = resolveAdapters(config).map((a) =>
    a({ deviceId: config.deviceId, clientVersion: CLIENT_VERSION }),
  );
  const stops: Stop[] = [];
  for (const a of adapters) {
    log(`starting adapter: ${a.name}`);
    const stop = await a.start((event) => {
      onEvent(event);
      batcher.enqueue(event);
    });
    stops.push(stop);
  }

  log(
    `bm-pilot daemon running — api=${config.apiUrl} adapters=${adapters.map((a) => a.name).join(",")}`,
  );

  return {
    async stop() {
      log("stopping adapters");
      for (const stop of stops) {
        try {
          await stop();
        } catch (err) {
          log(`adapter stop error: ${errMessage(err)}`);
        }
      }
      log("draining batcher");
      await batcher.stop();
      try {
        await clearCurrentSession(sessionPath);
      } catch (err) {
        log(`clear current-session failed: ${errMessage(err)}`);
      }
      log("stopped");
    },
  };
}

function resolveAdapters(config: Config): Array<ReturnType<typeof pickAdapter>> {
  const out: Array<ReturnType<typeof pickAdapter>> = [];
  for (const [name, cfg] of Object.entries(config.adapters)) {
    if (!cfg.enabled) continue;
    out.push(pickAdapter(name));
  }
  if (out.length === 0) out.push(pickAdapter("mock"));
  return out;
}

function pickAdapter(name: string): (ctx: { deviceId: string; clientVersion: string }) => Adapter {
  switch (name) {
    case "mock":
      return (ctx) => createMockAdapter(ctx);
    case "claude-code":
      return (ctx) => createClaudeCodeAdapter(ctx);
    case "codex":
      return (ctx) => createCodexAdapter(ctx);
    case "cursor":
      return (ctx) => createCursorAdapter(ctx);
    default:
      throw new Error(`unknown adapter: ${name}`);
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function defaultLog(msg: string): void {
  console.log(`[bm-pilot] ${msg}`);
}

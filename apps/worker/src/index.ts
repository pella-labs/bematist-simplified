import { MiniLmProvider } from "@bematist/embed";
import postgres from "postgres";
import { type EmbedLoopHandle, startEmbedLoop } from "./jobs/embedPrompts";
import { runReclusterOnce } from "./jobs/recluster";

const DEFAULT_EMBED_INTERVAL_MS = 30_000;
const DEFAULT_RECLUSTER_INTERVAL_MS = 24 * 60 * 60 * 1000;

function resolveUrl(): string {
  const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("ADMIN_DATABASE_URL or DATABASE_URL must be set");
  return url;
}

function parseIntervalMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export interface WorkerHandle {
  stop: () => Promise<void>;
}

export async function startWorker(): Promise<WorkerHandle> {
  const sql = postgres(resolveUrl(), { max: 3, prepare: false });
  const provider = MiniLmProvider;

  const embedIntervalMs = parseIntervalMs(
    process.env.WORKER_EMBED_INTERVAL_MS,
    DEFAULT_EMBED_INTERVAL_MS,
  );
  const reclusterIntervalMs = parseIntervalMs(
    process.env.WORKER_RECLUSTER_INTERVAL_MS,
    DEFAULT_RECLUSTER_INTERVAL_MS,
  );

  const embedHandle: EmbedLoopHandle = startEmbedLoop({
    sql,
    provider,
    intervalMs: embedIntervalMs,
  });

  let reclusterRunning: Promise<unknown> | null = null;
  const reclusterTimer = setInterval(() => {
    if (reclusterRunning) return;
    reclusterRunning = runReclusterOnce({ sql })
      .catch((err) => {
        console.error("[worker/recluster] tick failed:", err);
      })
      .finally(() => {
        reclusterRunning = null;
      });
  }, reclusterIntervalMs);

  console.log(
    `[worker] started; embed interval=${embedIntervalMs}ms, recluster interval=${reclusterIntervalMs}ms`,
  );

  return {
    async stop() {
      clearInterval(reclusterTimer);
      await embedHandle.stop();
      if (reclusterRunning) await reclusterRunning;
      await sql.end({ timeout: 5 });
      console.log("[worker] stopped");
    },
  };
}

// When invoked directly (`bun run src/index.ts` or `bun run worker`), bootstrap
// the long-running process and wire SIGTERM/SIGINT to drain in-flight work.
if (import.meta.main) {
  const handle = await startWorker();
  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, draining…`);
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

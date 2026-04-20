import type { EventEnvelope } from "@bematist/contracts";
import { BATCH_MAX } from "@bematist/contracts";
import {
  UploadAuthError,
  type Uploader,
  UploadPermanentError,
  UploadRetriesExhaustedError,
} from "./uploader";

export interface BatcherOptions {
  uploader: Pick<Uploader, "upload">;
  maxBatchSize?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  onFlushSuccess?: (r: { accepted: number; deduped: number; attempted: number }) => void;
  onFlushError?: (err: unknown, attempted: number) => void;
  onDrop?: (count: number) => void;
  clock?: {
    setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (t: ReturnType<typeof setTimeout>) => void;
    now: () => number;
  };
}

export interface FlushStats {
  lastFlushAt: number | null;
  lastFlushAccepted: number;
  lastFlushDeduped: number;
  totalAccepted: number;
  totalDeduped: number;
  totalDropped: number;
  queueSize: number;
}

export class Batcher {
  private readonly uploader: Pick<Uploader, "upload">;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxQueueSize: number;
  private readonly onFlushSuccess?: BatcherOptions["onFlushSuccess"];
  private readonly onFlushError?: BatcherOptions["onFlushError"];
  private readonly onDrop?: BatcherOptions["onDrop"];
  private readonly clock: NonNullable<BatcherOptions["clock"]>;

  private queue: EventEnvelope[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private pendingFlush: Promise<void> | null = null;
  private stopped = false;
  private stats: FlushStats = {
    lastFlushAt: null,
    lastFlushAccepted: 0,
    lastFlushDeduped: 0,
    totalAccepted: 0,
    totalDeduped: 0,
    totalDropped: 0,
    queueSize: 0,
  };

  constructor(opts: BatcherOptions) {
    this.uploader = opts.uploader;
    this.maxBatchSize = Math.min(opts.maxBatchSize ?? 100, BATCH_MAX);
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000;
    this.maxQueueSize = opts.maxQueueSize ?? 10_000;
    this.onFlushSuccess = opts.onFlushSuccess;
    this.onFlushError = opts.onFlushError;
    this.onDrop = opts.onDrop;
    this.clock = opts.clock ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t),
      now: () => Date.now(),
    };
  }

  enqueue(event: EventEnvelope): void {
    if (this.stopped) return;
    if (this.queue.length >= this.maxQueueSize) {
      const drop = this.queue.length - this.maxQueueSize + 1;
      this.queue.splice(0, drop);
      this.stats.totalDropped += drop;
      this.onDrop?.(drop);
    }
    this.queue.push(event);
    this.stats.queueSize = this.queue.length;
    if (this.queue.length >= this.maxBatchSize) {
      void this.flush();
      return;
    }
    this.ensureTimer();
  }

  getStats(): FlushStats {
    return { ...this.stats, queueSize: this.queue.length };
  }

  async flush(): Promise<void> {
    if (this.pendingFlush) return this.pendingFlush;
    this.pendingFlush = this.doFlush().finally(() => {
      this.pendingFlush = null;
    });
    return this.pendingFlush;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    while (this.queue.length > 0) {
      const before = this.queue.length;
      await this.flush();
      if (this.queue.length >= before) break;
    }
    if (this.pendingFlush) await this.pendingFlush;
  }

  private ensureTimer(): void {
    if (this.timer || this.stopped) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushIntervalMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async doFlush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const chunk = this.queue.slice(0, this.maxBatchSize);
        try {
          const result = await this.uploader.upload(chunk);
          this.queue.splice(0, chunk.length);
          this.stats.lastFlushAt = this.clock.now();
          this.stats.lastFlushAccepted = result.accepted;
          this.stats.lastFlushDeduped = result.deduped;
          this.stats.totalAccepted += result.accepted;
          this.stats.totalDeduped += result.deduped;
          this.stats.queueSize = this.queue.length;
          this.onFlushSuccess?.({
            accepted: result.accepted,
            deduped: result.deduped,
            attempted: chunk.length,
          });
        } catch (err) {
          this.onFlushError?.(err, chunk.length);
          if (err instanceof UploadPermanentError) {
            this.queue.splice(0, chunk.length);
            this.stats.totalDropped += chunk.length;
            this.stats.queueSize = this.queue.length;
            this.onDrop?.(chunk.length);
            continue;
          }
          if (err instanceof UploadAuthError) {
            return;
          }
          if (err instanceof UploadRetriesExhaustedError) {
            this.clearTimer();
            this.ensureTimer();
            return;
          }
          this.clearTimer();
          this.ensureTimer();
          return;
        }
      }
      this.clearTimer();
    } finally {
      this.flushing = false;
    }
  }
}

import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@bematist/contracts";
import { Batcher } from "../src/batcher";
import {
  UploadAuthError,
  UploadPermanentError,
  UploadRetriesExhaustedError,
} from "../src/uploader";

function env(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  const base: EventEnvelope = {
    client_event_id: randomUUID(),
    schema_version: 1,
    session_id: "sess-1",
    source_session_id: "src-sess-1",
    source: "claude-code",
    source_version: "1.0.0",
    client_version: "0.1.0",
    ts: new Date().toISOString(),
    event_seq: 0,
    kind: "user_prompt",
    payload: { kind: "user_prompt", text: "hi" },
    cwd: null,
    git_branch: null,
    git_sha: null,
    model: null,
    usage: null,
    duration_ms: null,
    success: null,
    raw: null,
  };
  return { ...base, ...overrides };
}

class RecordingUploader {
  readonly batches: EventEnvelope[][] = [];
  behavior: (batch: EventEnvelope[]) => Promise<{ accepted: number; deduped: number }> = async (
    b,
  ) => ({
    accepted: b.length,
    deduped: 0,
  });

  async upload(batch: EventEnvelope[]): Promise<{ accepted: number; deduped: number }> {
    this.batches.push(batch);
    return this.behavior(batch);
  }
}

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Batcher", () => {
  it("flushes immediately when size threshold is reached", async () => {
    const up = new RecordingUploader();
    const b = new Batcher({ uploader: up, maxBatchSize: 3, flushIntervalMs: 10_000 });
    b.enqueue(env({ event_seq: 0 }));
    b.enqueue(env({ event_seq: 1 }));
    b.enqueue(env({ event_seq: 2 }));
    await wait(20);
    await b.stop();
    expect(up.batches.length).toBe(1);
    expect(up.batches[0]).toHaveLength(3);
  });

  it("flushes after the idle interval passes", async () => {
    const up = new RecordingUploader();
    const b = new Batcher({ uploader: up, maxBatchSize: 100, flushIntervalMs: 50 });
    b.enqueue(env());
    b.enqueue(env());
    await wait(120);
    await b.stop();
    expect(up.batches.length).toBe(1);
    expect(up.batches[0]).toHaveLength(2);
  });

  it("drains remaining events on stop", async () => {
    const up = new RecordingUploader();
    const b = new Batcher({ uploader: up, maxBatchSize: 1000, flushIntervalMs: 10_000 });
    b.enqueue(env());
    b.enqueue(env());
    await b.stop();
    expect(up.batches.length).toBe(1);
    expect(up.batches[0]).toHaveLength(2);
  });

  it("does not re-enqueue events after a successful upload (dedup semantics)", async () => {
    const up = new RecordingUploader();
    up.behavior = async (batch) => ({ accepted: 1, deduped: batch.length - 1 });
    const b = new Batcher({ uploader: up, maxBatchSize: 2, flushIntervalMs: 10_000 });
    b.enqueue(env());
    b.enqueue(env());
    await wait(20);
    await b.stop();
    expect(up.batches.length).toBe(1);
    expect(b.getStats().queueSize).toBe(0);
    expect(b.getStats().totalAccepted).toBe(1);
    expect(b.getStats().totalDeduped).toBe(1);
  });

  it("retains queued events when uploader retries are exhausted", async () => {
    const up = new RecordingUploader();
    up.behavior = async () => {
      throw new UploadRetriesExhaustedError(3);
    };
    const b = new Batcher({ uploader: up, maxBatchSize: 2, flushIntervalMs: 10_000 });
    b.enqueue(env());
    b.enqueue(env());
    await wait(20);
    const stats = b.getStats();
    expect(stats.queueSize).toBe(2);
    expect(stats.totalAccepted).toBe(0);
    up.behavior = async (batch) => ({ accepted: batch.length, deduped: 0 });
    await b.flush();
    expect(b.getStats().queueSize).toBe(0);
    expect(b.getStats().totalAccepted).toBe(2);
    await b.stop();
  });

  it("drops events on a permanent (4xx) server error", async () => {
    const up = new RecordingUploader();
    up.behavior = async () => {
      throw new UploadPermanentError(400, "bad");
    };
    const b = new Batcher({ uploader: up, maxBatchSize: 10, flushIntervalMs: 10_000 });
    b.enqueue(env());
    b.enqueue(env());
    await b.stop();
    expect(b.getStats().totalDropped).toBe(2);
    expect(b.getStats().queueSize).toBe(0);
  });

  it("stops flushing on auth error and retains queue", async () => {
    const up = new RecordingUploader();
    up.behavior = async () => {
      throw new UploadAuthError(401, "unauthorized");
    };
    const errors: unknown[] = [];
    const b = new Batcher({
      uploader: up,
      maxBatchSize: 10,
      flushIntervalMs: 10_000,
      onFlushError: (e) => errors.push(e),
    });
    b.enqueue(env());
    await b.flush();
    expect(errors).toHaveLength(1);
    expect(b.getStats().queueSize).toBe(1);
  });

  it("records lastFlushAt after a successful flush", async () => {
    const up = new RecordingUploader();
    const b = new Batcher({ uploader: up, maxBatchSize: 1, flushIntervalMs: 10_000 });
    b.enqueue(env());
    await wait(10);
    await b.stop();
    expect(b.getStats().lastFlushAt).not.toBeNull();
  });
});

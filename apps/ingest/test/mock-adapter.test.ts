import { describe, expect, it } from "bun:test";
import { EventEnvelopeSchema } from "@bematist/contracts";
import { createMockAdapter } from "../src/adapters/mock";

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("mock adapter", () => {
  it("emits events that validate against EventEnvelopeSchema", async () => {
    const emitted: unknown[] = [];
    const adapter = createMockAdapter({ deviceId: "dev-1", clientVersion: "0.1.0" }, 2);
    const stop = await adapter.start((e) => emitted.push(e));
    await wait(300);
    await stop();
    expect(emitted.length).toBeGreaterThan(0);
    for (const raw of emitted) {
      const parsed = EventEnvelopeSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`envelope invalid: ${JSON.stringify(parsed.error.issues)}`);
      }
    }
  });

  it("emits session_start for each session and session_end on stop", async () => {
    const emitted: Array<{ kind: string; session_id: string }> = [];
    const adapter = createMockAdapter({ deviceId: "dev-1", clientVersion: "0.1.0" }, 2);
    const stop = await adapter.start((e) =>
      emitted.push({ kind: e.kind, session_id: e.session_id }),
    );
    await wait(50);
    await stop();
    const sessionStarts = emitted.filter((e) => e.kind === "session_start");
    const sessionEnds = emitted.filter((e) => e.kind === "session_end");
    expect(sessionStarts.length).toBe(2);
    expect(sessionEnds.length).toBe(2);
    const startIds = new Set(sessionStarts.map((e) => e.session_id));
    const endIds = new Set(sessionEnds.map((e) => e.session_id));
    expect(startIds).toEqual(endIds);
  });

  it("roughly targets 5 events/sec", async () => {
    const emitted: unknown[] = [];
    const adapter = createMockAdapter({ deviceId: "dev-1", clientVersion: "0.1.0" }, 2);
    const stop = await adapter.start((e) => emitted.push(e));
    await wait(1000);
    await stop();
    const steady = emitted.length - 4;
    expect(steady).toBeGreaterThanOrEqual(3);
    expect(steady).toBeLessThanOrEqual(12);
  });
});

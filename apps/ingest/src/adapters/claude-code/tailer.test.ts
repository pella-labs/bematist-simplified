import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@bematist/contracts";
import { EventEnvelopeSchema } from "@bematist/contracts";
import { createTailer } from "./tailer";

let tmp: string;
let projectsDir: string;
let stateDir: string;

function emitter(): { emit: (e: EventEnvelope) => void; events: EventEnvelope[] } {
  const events: EventEnvelope[] = [];
  return {
    emit: (e) => events.push(e),
    events,
  };
}

function userLine(uuid: string, sessionId: string, text: string, ts = "2026-04-16T14:00:00.000Z") {
  return `${JSON.stringify({
    type: "user",
    uuid,
    timestamp: ts,
    sessionId,
    cwd: "/tmp/demo",
    gitBranch: "main",
    version: "2.1.76",
    message: { role: "user", content: text },
  })}\n`;
}

function assistantLine(
  uuid: string,
  sessionId: string,
  text: string,
  ts = "2026-04-16T14:00:01.000Z",
) {
  return `${JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: ts,
    sessionId,
    cwd: "/tmp/demo",
    gitBranch: "main",
    version: "2.1.76",
    requestId: `req_${uuid}`,
    message: {
      id: `msg_${uuid}`,
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  })}\n`;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bm-pilot-tailer-"));
  projectsDir = join(tmp, "projects");
  stateDir = join(tmp, "state");
  await mkdir(projectsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("createTailer", () => {
  it("skips existing file content on first discovery (no historical backfill)", async () => {
    const f = join(projectsDir, "hist.jsonl");
    await writeFile(
      f,
      userLine("11111111-1111-4111-8111-111111111111", "s-hist", "existing") +
        assistantLine("22222222-2222-4222-8222-222222222222", "s-hist", "already-there"),
    );

    const { emit, events } = emitter();
    const tailer = createTailer({
      projectsDir,
      stateDir,
      clientVersion: "0.1.0-test",
      emit,
    });
    await tailer.start();
    await tailer.stop();
    expect(events).toEqual([]);
  });

  it("picks up new lines appended after discovery", async () => {
    const f = join(projectsDir, "live.jsonl");
    await writeFile(f, "");

    const { emit, events } = emitter();
    const tailer = createTailer({
      projectsDir,
      stateDir,
      clientVersion: "0.1.0-test",
      emit,
    });
    await tailer.start();
    await Bun.write(
      f,
      userLine("11111111-1111-4111-8111-aaaaaaaaaaaa", "s-live", "hello") +
        assistantLine("22222222-2222-4222-8222-bbbbbbbbbbbb", "s-live", "world"),
    );
    await tailer.tick();
    await tailer.stop();

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("user_prompt");
    expect(kinds).toContain("assistant_response");
    expect(kinds).toContain("session_start");
    for (const e of events) expect(() => EventEnvelopeSchema.parse(e)).not.toThrow();
  });

  it("detects new jsonl files created in the watched dir", async () => {
    const { emit, events } = emitter();
    const tailer = createTailer({
      projectsDir,
      stateDir,
      clientVersion: "0.1.0-test",
      emit,
    });
    await tailer.start();

    const sub = join(projectsDir, "nested");
    await mkdir(sub, { recursive: true });
    const f = join(sub, "new.jsonl");
    await writeFile(f, userLine("33333333-3333-4333-8333-cccccccccccc", "s-new", "hi"));

    await tailer.tick();
    await tailer.stop();

    expect(events.some((e) => e.kind === "user_prompt")).toBe(true);
    expect(events.some((e) => e.kind === "session_start")).toBe(true);
  });

  it("persists offsets atomically so subsequent starts don't re-emit", async () => {
    const f = join(projectsDir, "persist.jsonl");
    await writeFile(f, "");

    const first = emitter();
    const t1 = createTailer({
      projectsDir,
      stateDir,
      clientVersion: "0.1.0-test",
      emit: first.emit,
    });
    await t1.start();
    await Bun.write(
      f,
      userLine("44444444-4444-4444-8444-dddddddddddd", "s-p", "one") +
        assistantLine("55555555-5555-4555-8555-eeeeeeeeeeee", "s-p", "two"),
    );
    await t1.tick();
    await t1.stop();
    const firstCount = first.events.length;
    expect(firstCount).toBeGreaterThan(0);

    const offsetsRaw = await readFile(join(stateDir, "offsets-claude-code.json"), "utf8");
    const parsed = JSON.parse(offsetsRaw) as { version: number; files: Record<string, number> };
    expect(parsed.version).toBe(1);
    expect(parsed.files[f]).toBeGreaterThan(0);

    const second = emitter();
    const t2 = createTailer({
      projectsDir,
      stateDir,
      clientVersion: "0.1.0-test",
      emit: second.emit,
    });
    await t2.start();
    await t2.tick();
    await t2.stop();
    expect(second.events).toEqual([]);
  });

  it("attaches git_sha from the queue file", async () => {
    const f = join(projectsDir, "sha.jsonl");
    await writeFile(f, "");
    const queueDir = join(stateDir, "git-sha-queue");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      join(queueDir, "s-sha.json"),
      JSON.stringify({
        sessionId: "s-sha",
        cwd: "/tmp/demo",
        sha: "cafe1234",
        branch: "main",
        capturedAt: new Date().toISOString(),
      }),
    );

    const { emit, events } = emitter();
    const tailer = createTailer({
      projectsDir,
      stateDir,
      clientVersion: "0.1.0-test",
      emit,
    });
    await tailer.start();
    await Bun.write(f, userLine("66666666-6666-4666-8666-ffffffffffff", "s-sha", "go"));
    await tailer.tick();
    await tailer.stop();
    const userEvent = events.find((e) => e.kind === "user_prompt");
    expect(userEvent).toBeDefined();
    expect(userEvent?.git_sha).toBe("cafe1234");
  });

  it("dedups via (sessionId, uuid) — repeated uuid emitted once", async () => {
    const f = join(projectsDir, "dedup.jsonl");
    await writeFile(f, "");
    const { emit, events } = emitter();
    const tailer = createTailer({
      projectsDir,
      stateDir,
      clientVersion: "0.1.0-test",
      emit,
    });
    await tailer.start();

    const dupUuid = "77777777-7777-4777-8777-777777777777";
    await Bun.write(
      f,
      userLine(dupUuid, "s-dedup", "first") + userLine(dupUuid, "s-dedup", "second"),
    );
    await tailer.tick();
    await tailer.stop();
    const userEvents = events.filter((e) => e.kind === "user_prompt");
    expect(userEvents).toHaveLength(1);
  });

  it("emits session_end on file rotation and a new session_start", async () => {
    const f = join(projectsDir, "rot.jsonl");
    await writeFile(f, "");
    const { emit, events } = emitter();
    const tailer = createTailer({
      projectsDir,
      stateDir,
      clientVersion: "0.1.0-test",
      emit,
    });
    await tailer.start();
    await writeFile(f, userLine("88888888-8888-4888-8888-888888888881", "s-rot", "hi"));
    await tailer.tick();
    expect(events.length).toBeGreaterThan(0);

    await unlink(f);
    await writeFile(f, userLine("99999999-9999-4999-8999-999999999999", "s-rot-new", "after"));
    await tailer.tick();
    await tailer.stop();

    const ends = events.filter((e) => e.kind === "session_end");
    const starts = events.filter((e) => e.kind === "session_start");
    expect(ends.length).toBeGreaterThanOrEqual(1);
    expect(starts.length).toBeGreaterThanOrEqual(2);
  });

  it("survives concurrent offset writes without corruption", async () => {
    const f = join(projectsDir, "concurrent.jsonl");
    await writeFile(f, "");
    const { emit } = emitter();
    const tailer = createTailer({
      projectsDir,
      stateDir,
      clientVersion: "0.1.0-test",
      emit,
    });
    await tailer.start();
    for (let i = 0; i < 20; i++) {
      const uuid = `0${i.toString().padStart(7, "0")}-0000-4000-8000-000000000001`;
      await Bun.write(f, userLine(uuid, "s-conc", `line-${i}`), { createPath: false });
    }
    await Promise.all([tailer.tick(), tailer.tick(), tailer.tick()]);
    await tailer.stop();

    const raw = await readFile(join(stateDir, "offsets-claude-code.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@bematist/contracts";
import { createClaudeCodeAdapter } from "./index";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bm-pilot-adapter-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("createClaudeCodeAdapter", () => {
  it("exports the frozen Adapter shape and tails a live file", async () => {
    const projectsDir = join(tmp, "projects");
    const stateDir = join(tmp, "state");
    await mkdir(projectsDir, { recursive: true });
    const adapter = createClaudeCodeAdapter(
      { deviceId: "d", clientVersion: "0.1.0-test" },
      {
        projectsDir,
        stateDir,
        skipInstallHook: true,
        pollIntervalMs: 10_000,
      },
    );
    expect(adapter.name).toBe("claude-code");
    const seen: EventEnvelope[] = [];
    const stop = await adapter.start((e) => seen.push(e));

    const f = join(projectsDir, "s.jsonl");
    await writeFile(
      f,
      `${JSON.stringify({
        type: "user",
        uuid: "aaaa1111-2222-4222-8222-333333333333",
        timestamp: "2026-04-16T00:00:00.000Z",
        sessionId: "sess-adapter",
        cwd: "/x",
        gitBranch: "main",
        version: "2.1.76",
        message: { role: "user", content: "hi" },
      })}\n`,
    );

    // The tailer's initial scan happened before we wrote; force another scan
    // by stopping which runs a final flush.
    await stop();
    const kinds = seen.map((e) => e.kind);
    expect(kinds).toContain("user_prompt");
    expect(kinds).toContain("session_start");
  });

  it("installs the SessionStart hook when not skipped", async () => {
    const projectsDir = join(tmp, "projects");
    const stateDir = join(tmp, "state");
    const settingsPath = join(tmp, "claude", "settings.json");
    await mkdir(projectsDir, { recursive: true });
    const adapter = createClaudeCodeAdapter(
      { deviceId: "d", clientVersion: "0.1.0-test" },
      {
        projectsDir,
        stateDir,
        settingsPath,
        pollIntervalMs: 10_000,
      },
    );
    const stop = await adapter.start(() => {});
    await stop();
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    const hooks = settings.hooks.SessionStart[0].hooks;
    expect(hooks.some((h: { command: string }) => h.command === "bm-pilot capture-git-sha")).toBe(
      true,
    );
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@bematist/contracts";
import { freshConfig, writeConfig } from "../../config";
import { createCursorAdapter, disableCursor, ensureCursorConsent } from "./index";

let dir: string;
let configPath: string;
let hooksPath: string;
const binaryPath = "/usr/local/bin/bm-pilot";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bm-idx-"));
  configPath = join(dir, "config.json");
  hooksPath = join(dir, ".cursor", "hooks.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedConfig() {
  const cfg = {
    ...freshConfig("http://localhost:8000"),
    ingestKey: `bm_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa_abcdefgh_${"a".repeat(32)}`,
  };
  await writeConfig(cfg, configPath);
}

describe("ensureCursorConsent", () => {
  test("yes-path persists enabled=true + promptedAt and installs hooks", async () => {
    await seedConfig();
    const answers = ["\n"];
    const result = await ensureCursorConsent({
      configPath,
      hooksPath,
      binaryPath,
      now: () => "2026-04-20T00:00:00.000Z",
      prompts: {
        async prompt() {
          return answers.shift() ?? "";
        },
        print() {},
      },
    });
    expect(result.enabled).toBe(true);
    expect(result.promptedAt).toBe("2026-04-20T00:00:00.000Z");
    expect(result.hooksInstalled).toBe(true);

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    expect(persisted.adapters.cursor.enabled).toBe(true);
    expect(persisted.adapters.cursor.promptedAt).toBe("2026-04-20T00:00:00.000Z");
  });

  test("no-path persists enabled=false + promptedAt, hooks file not created", async () => {
    await seedConfig();
    const result = await ensureCursorConsent({
      configPath,
      hooksPath,
      binaryPath,
      now: () => "2026-04-20T00:00:00.000Z",
      prompts: {
        async prompt() {
          return "n";
        },
        print() {},
      },
    });
    expect(result.enabled).toBe(false);
    expect(result.hooksInstalled).toBe(false);

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    expect(persisted.adapters.cursor.enabled).toBe(false);
    expect(persisted.adapters.cursor.promptedAt).toBe("2026-04-20T00:00:00.000Z");
    await expect(readFile(hooksPath, "utf8")).rejects.toThrow();
  });

  test("second call after prior prompt is a no-op", async () => {
    await seedConfig();
    let promptCount = 0;
    const opts = {
      configPath,
      hooksPath,
      binaryPath,
      now: () => "2026-04-20T00:00:00.000Z",
      prompts: {
        async prompt() {
          promptCount++;
          return "y";
        },
        print() {},
      },
    };
    await ensureCursorConsent(opts);
    await ensureCursorConsent(opts);
    expect(promptCount).toBe(1);
  });
});

describe("disableCursor", () => {
  test("sets enabled=false and strips our entries from hooks.json", async () => {
    await seedConfig();
    await ensureCursorConsent({
      configPath,
      hooksPath,
      binaryPath,
      now: () => "2026-04-20T00:00:00.000Z",
      prompts: {
        async prompt() {
          return "y";
        },
        print() {},
      },
    });

    const r = await disableCursor({
      configPath,
      hooksPath,
      now: () => "2026-04-21T00:00:00.000Z",
    });
    expect(r.hooksRemoved).toBe(true);

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    expect(persisted.adapters.cursor.enabled).toBe(false);

    const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
    const beforeList = hooks.hooks?.beforeSubmitPrompt ?? [];
    const ours = beforeList.find((e: { source?: string }) => e.source === "bm-pilot");
    expect(ours).toBeUndefined();
  });
});

describe("createCursorAdapter", () => {
  test("start returns an adapter whose emit receives normalized events from socket", async () => {
    const adapter = createCursorAdapter(
      { deviceId: "11111111-1111-1111-1111-111111111111", clientVersion: "0.1.0" },
      { socketAddress: join(dir, "adapter.sock") },
    );
    const events: EventEnvelope[] = [];
    const stop = await adapter.start((e) => events.push(e));
    try {
      const { connect } = await import("node:net");
      await new Promise<void>((resolve, reject) => {
        const c = connect(join(dir, "adapter.sock"));
        c.once("connect", () => {
          c.write('{"hook_event_name":"sessionStart","session_id":"abc"}\n');
        });
        c.setEncoding("utf8");
        c.on("data", () => {
          c.end();
          resolve();
        });
        c.on("error", reject);
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe("session_start");
      expect(events[0]!.source).toBe("cursor");
    } finally {
      await stop();
    }
  });
});

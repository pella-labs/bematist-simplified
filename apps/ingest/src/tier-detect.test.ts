import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTiers } from "./tier-detect";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bm-tier-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeClaude(creds: unknown): Promise<void> {
  const dir = join(home, ".claude");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".credentials.json"), JSON.stringify(creds));
}

async function writeCodex(auth: unknown): Promise<void> {
  const dir = join(home, ".codex");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "auth.json"), JSON.stringify(auth));
}

describe("detectTiers", () => {
  test("no files and no env → all null (cursor always null)", async () => {
    const result = await detectTiers({ homeDir: home, env: {} });
    expect(result).toEqual({ claude: null, codex: null, cursor: null });
  });

  test("ANTHROPIC_API_KEY set and no creds file → claude=api_key", async () => {
    const result = await detectTiers({
      homeDir: home,
      env: { ANTHROPIC_API_KEY: "sk-ant-abc" },
    });
    expect(result.claude).toBe("api_key");
  });

  test("OPENAI_API_KEY set and no auth file → codex=api_key", async () => {
    const result = await detectTiers({
      homeDir: home,
      env: { OPENAI_API_KEY: "sk-openai-abc" },
    });
    expect(result.codex).toBe("api_key");
  });

  test("claude creds with plan='max' → max_200", async () => {
    await writeClaude({ subscription: { plan: "max" }, access_token: "tok" });
    const result = await detectTiers({ homeDir: home, env: {} });
    expect(result.claude).toBe("max_200");
  });

  test("claude creds with plan='pro' → pro_20", async () => {
    await writeClaude({ subscription: { plan: "pro" } });
    const result = await detectTiers({ homeDir: home, env: {} });
    expect(result.claude).toBe("pro_20");
  });

  test("claude creds oauth-shape with no explicit plan → pro_20 fallback", async () => {
    await writeClaude({ access_token: "tok", refresh_token: "r" });
    const result = await detectTiers({ homeDir: home, env: {} });
    expect(result.claude).toBe("pro_20");
  });

  test("claude creds file but ANTHROPIC_API_KEY is ignored when creds win", async () => {
    await writeClaude({ subscription: { plan: "max" } });
    const result = await detectTiers({
      homeDir: home,
      env: { ANTHROPIC_API_KEY: "sk-ant-abc" },
    });
    expect(result.claude).toBe("max_200");
  });

  test("codex auth.json with tokens.plan='team' → team", async () => {
    await writeCodex({ tokens: { plan: "team" } });
    const result = await detectTiers({ homeDir: home, env: {} });
    expect(result.codex).toBe("team");
  });

  test("codex auth.json with plan='pro' → pro", async () => {
    await writeCodex({ plan: "pro" });
    const result = await detectTiers({ homeDir: home, env: {} });
    expect(result.codex).toBe("pro");
  });

  test("codex auth.json with plan='plus' → plus", async () => {
    await writeCodex({ tokens: { plan: "plus" } });
    const result = await detectTiers({ homeDir: home, env: {} });
    expect(result.codex).toBe("plus");
  });

  test("codex auth.json with unknown-shape tokens → plus fallback", async () => {
    await writeCodex({ tokens: { id_token: "jwt" } });
    const result = await detectTiers({ homeDir: home, env: {} });
    expect(result.codex).toBe("plus");
  });

  test("cursor is always null even with every input set", async () => {
    await writeClaude({ subscription: { plan: "max" } });
    await writeCodex({ tokens: { plan: "team" } });
    const result = await detectTiers({
      homeDir: home,
      env: { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b" },
    });
    expect(result.cursor).toBeNull();
  });

  test("malformed JSON in credentials does not throw", async () => {
    const dir = join(home, ".claude");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".credentials.json"), "{not-json");
    const result = await detectTiers({
      homeDir: home,
      env: { ANTHROPIC_API_KEY: "sk-ant" },
    });
    expect(result.claude).toBe("api_key");
  });
});

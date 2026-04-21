import { describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { type LoginPrompts, runLoginFlow, validateIngestKey } from "./auth";
import { freshConfig } from "./config";

describe("validateIngestKey", () => {
  test("accepts a key matching the api parser output", () => {
    const orgId = randomUUID();
    const suffix = randomBytes(6).toString("hex");
    const secret = randomBytes(32).toString("hex");
    const key = `bm_${orgId}_${suffix}_${secret}`;
    expect(() => validateIngestKey(key)).not.toThrow();
  });

  test("accepts the keyId when it is mixed-case alphanumeric", () => {
    const orgId = randomUUID();
    const suffix = "AbCdEf012345";
    const secret = randomBytes(32).toString("hex");
    const key = `bm_${orgId}_${suffix}_${secret}`;
    expect(() => validateIngestKey(key)).not.toThrow();
  });

  test("rejects a dot-separated plaintext (legacy format)", () => {
    const orgId = randomUUID();
    const suffix = randomBytes(6).toString("hex");
    const secret = randomBytes(32).toString("hex");
    const legacy = `bm_${orgId}_${suffix}.${secret}`;
    expect(() => validateIngestKey(legacy)).toThrow(/format invalid/);
  });

  test("rejects a bare non-UUID orgId", () => {
    const secret = randomBytes(32).toString("hex");
    const bad = `bm_not-a-uuid_${"a".repeat(12)}_${secret}`;
    expect(() => validateIngestKey(bad)).toThrow(/format invalid/);
  });

  test("rejects an orgId without dashes (hex-packed)", () => {
    const packed = "0123456789abcdef0123456789abcdef";
    const suffix = randomBytes(6).toString("hex");
    const secret = randomBytes(32).toString("hex");
    const bad = `bm_${packed}_${suffix}_${secret}`;
    expect(() => validateIngestKey(bad)).toThrow(/format invalid/);
  });

  test("rejects a secret shorter than 16 chars", () => {
    const orgId = randomUUID();
    const suffix = randomBytes(6).toString("hex");
    const bad = `bm_${orgId}_${suffix}_${"a".repeat(15)}`;
    expect(() => validateIngestKey(bad)).toThrow(/format invalid/);
  });
});

describe("runLoginFlow positional token", () => {
  const validKey = (): string => {
    const orgId = randomUUID();
    const suffix = randomBytes(6).toString("hex");
    const secret = randomBytes(32).toString("hex");
    return `bm_${orgId}_${suffix}_${secret}`;
  };

  test("uses positional token without prompting", async () => {
    let prompted = false;
    const prompts: LoginPrompts = {
      prompt: async () => {
        prompted = true;
        return "";
      },
      print: () => {},
    };
    const key = validKey();
    const next = await runLoginFlow(prompts, freshConfig("http://localhost:8000"), { token: key });
    expect(next.ingestKey).toBe(key);
    expect(prompted).toBe(false);
  });

  test("trims whitespace around a positional token", async () => {
    const prompts: LoginPrompts = {
      prompt: async () => "",
      print: () => {},
    };
    const key = validKey();
    const next = await runLoginFlow(prompts, freshConfig(), { token: `  ${key}\n` });
    expect(next.ingestKey).toBe(key);
  });

  test("rejects an invalid positional token", async () => {
    const prompts: LoginPrompts = {
      prompt: async () => "",
      print: () => {},
    };
    await expect(runLoginFlow(prompts, freshConfig(), { token: "bm_not-valid" })).rejects.toThrow(
      /format invalid/,
    );
  });

  test("falls back to prompting when no token provided", async () => {
    let prompted = false;
    const key = validKey();
    const prompts: LoginPrompts = {
      prompt: async () => {
        prompted = true;
        return key;
      },
      print: () => {},
    };
    const next = await runLoginFlow(prompts, freshConfig());
    expect(prompted).toBe(true);
    expect(next.ingestKey).toBe(key);
  });
});

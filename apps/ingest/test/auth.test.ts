import { describe, expect, it } from "bun:test";
import { clearIngestKey, runLoginFlow, validateIngestKey } from "../src/auth";
import { freshConfig } from "../src/config";

describe("auth", () => {
  it("accepts a well-formed ingest key", () => {
    const key = `bm_00000000-0000-0000-0000-000000000000_keyid123_${"a".repeat(32)}`;
    expect(() => validateIngestKey(key)).not.toThrow();
  });

  it("rejects an obviously-bad ingest key", () => {
    expect(() => validateIngestKey("xyz")).toThrow();
    expect(() => validateIngestKey("bm_bad_bad_bad")).toThrow();
  });

  it("runLoginFlow writes the pasted key into the config", async () => {
    const key = `bm_00000000-0000-0000-0000-000000000000_keyid123_${"b".repeat(32)}`;
    const printed: string[] = [];
    const updated = await runLoginFlow(
      {
        async prompt() {
          return `  ${key}  \n`;
        },
        print(msg) {
          printed.push(msg);
        },
      },
      freshConfig("http://api.example.com"),
    );
    expect(updated.ingestKey).toBe(key);
    expect(updated.apiUrl).toBe("http://api.example.com");
    expect(printed.length).toBeGreaterThan(0);
  });

  it("clearIngestKey preserves apiUrl + deviceId", () => {
    const c = freshConfig("http://api.example.com");
    c.ingestKey = `bm_00000000-0000-0000-0000-000000000000_keyid123_${"c".repeat(32)}`;
    const cleared = clearIngestKey(c);
    expect(cleared.ingestKey).toBeNull();
    expect(cleared.apiUrl).toBe(c.apiUrl);
    expect(cleared.deviceId).toBe(c.deviceId);
  });
});

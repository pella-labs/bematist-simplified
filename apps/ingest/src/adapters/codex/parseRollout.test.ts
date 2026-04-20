import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRolloutLine } from "./parseRollout";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "test", "fixtures", "codex");

function parseFile(name: string) {
  const raw = readFileSync(join(FIXTURES, name), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => parseRolloutLine(l));
}

describe("parseRolloutLine — basic fixture", () => {
  it("yields expected record kinds from rollout-basic.jsonl", () => {
    const outcomes = parseFile("rollout-basic.jsonl");
    const kinds = outcomes
      .map((o) => o.record?.kind)
      .filter((k): k is NonNullable<typeof k> => Boolean(k));
    expect(kinds).toEqual([
      "session_meta",
      "turn_context",
      "user_message",
      "tool_call",
      "tool_result",
      "assistant_message",
      "token_count",
      "user_message",
      "assistant_message",
      "token_count",
      "session_end",
    ]);
  });

  it("extracts cwd + cli_version from session_meta", () => {
    const [first] = parseFile("rollout-basic.jsonl");
    expect(first?.record?.kind).toBe("session_meta");
    if (first?.record?.kind !== "session_meta") throw new Error("wrong kind");
    expect(first.record.cwd).toBe("/tmp/repo-basic");
    expect(first.record.cli_version).toBe("0.120.0");
    expect(first.record.source_session_id).toBe("sess-basic-001");
  });

  it("extracts turn_context model from nested collaboration_mode.settings.model", () => {
    const outs = parseFile("rollout-basic.jsonl");
    const tc = outs.find((o) => o.record?.kind === "turn_context");
    if (tc?.record?.kind !== "turn_context") throw new Error("no turn_context");
    expect(tc.record.model).toBe("gpt-5.3-codex");
    expect(tc.record.turn_id).toBe("t1");
  });
});

describe("parseRolloutLine — info-shape fixture", () => {
  it("skips token_count with info:null and parses info.total_token_usage", () => {
    const outs = parseFile("rollout-info-shape.jsonl");
    const tokens = outs.filter((o) => o.record?.kind === "token_count");
    expect(tokens.length).toBe(2);
    const first = tokens[0]?.record;
    if (first?.kind !== "token_count") throw new Error("wrong kind");
    expect(first.cumulative.input_tokens).toBe(10843);
    expect(first.cumulative.total_tokens).toBe(11026);
  });

  it("marks info:null token_count as skipped (not an empty record)", () => {
    const outs = parseFile("rollout-info-shape.jsonl");
    const skipped = outs.filter((o) => o.skipped === "empty_token_count");
    expect(skipped.length).toBe(1);
  });
});

describe("parseRolloutLine — malformed and edge cases", () => {
  it("marks non-JSON lines as malformed", () => {
    expect(parseRolloutLine("not-json")).toEqual({ record: null, skipped: "malformed" });
    expect(parseRolloutLine("{").skipped).toBe("malformed");
  });

  it("skips empty lines", () => {
    expect(parseRolloutLine("")).toEqual({ record: null, skipped: "empty_line" });
    expect(parseRolloutLine("  ")).toEqual({ record: null, skipped: "empty_line" });
  });

  it("derives tool_name from exec_command_start command basename", () => {
    const line = JSON.stringify({
      session_id: "s",
      turn_id: "t",
      timestamp: "2026-04-16T14:00:00.000Z",
      event_msg: {
        type: "exec_command_start",
        payload: { command: "/usr/bin/git status --short", cwd: "/tmp/x" },
      },
    });
    const out = parseRolloutLine(line);
    if (out.record?.kind !== "tool_call") throw new Error("wrong kind");
    expect(out.record.tool_name).toBe("git");
  });

  it("maps patch_apply_start to apply_patch tool_call", () => {
    const line = JSON.stringify({
      session_id: "s",
      turn_id: "t",
      timestamp: "2026-04-16T14:00:00.000Z",
      event_msg: { type: "patch_apply_start", payload: { path: "src/foo.ts" } },
    });
    const out = parseRolloutLine(line);
    if (out.record?.kind !== "tool_call") throw new Error("wrong kind");
    expect(out.record.tool_name).toBe("apply_patch");
  });

  it("marks exec_command_end with non-zero exit as is_error", () => {
    const line = JSON.stringify({
      session_id: "s",
      turn_id: "t",
      timestamp: "2026-04-16T14:00:00.000Z",
      event_msg: { type: "exec_command_end", payload: { exit_code: 1, duration_ms: 100 } },
    });
    const out = parseRolloutLine(line);
    if (out.record?.kind !== "tool_result") throw new Error("wrong kind");
    expect(out.record.is_error).toBe(true);
  });

  it("tolerates top-level bare records (no event_msg wrapper)", () => {
    const line = JSON.stringify({
      type: "session_end",
      session_id: "s",
      timestamp: "2026-04-16T14:00:15.000Z",
    });
    const out = parseRolloutLine(line);
    expect(out.record?.kind).toBe("session_end");
  });
});

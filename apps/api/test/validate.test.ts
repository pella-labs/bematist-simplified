import { describe, expect, it } from "bun:test";
import { BATCH_MAX } from "@bematist/contracts";
import { ValidationError } from "../src/errors";
import { validateBatch } from "../src/pipeline/validate";
import { makeEnvelope } from "./fixtures/envelopes";

describe("validateBatch", () => {
  it("accepts a valid single-event batch", () => {
    const envelope = makeEnvelope();
    const result = validateBatch([envelope]);
    expect(result.length).toBe(1);
    expect(result[0]?.client_event_id).toBe(envelope.client_event_id);
  });

  it("rejects non-array input", () => {
    expect(() => validateBatch({} as unknown)).toThrow(ValidationError);
  });

  it("rejects an empty batch", () => {
    expect(() => validateBatch([])).toThrow(ValidationError);
  });

  it("rejects unknown fields (strict mode)", () => {
    const envelope = { ...makeEnvelope(), extra_field: "nope" } as unknown;
    expect(() => validateBatch([envelope])).toThrow(ValidationError);
  });

  it("rejects unknown fields inside payload", () => {
    const envelope = {
      ...makeEnvelope(),
      payload: { kind: "user_prompt", text: "hi", mystery: true },
    } as unknown;
    expect(() => validateBatch([envelope])).toThrow(ValidationError);
  });

  it("rejects missing required fields", () => {
    const envelope = { ...makeEnvelope() } as Record<string, unknown>;
    delete envelope.ts;
    expect(() => validateBatch([envelope])).toThrow(ValidationError);
  });

  it("rejects wrong types", () => {
    const envelope = { ...makeEnvelope(), event_seq: "zero" } as unknown;
    expect(() => validateBatch([envelope])).toThrow(ValidationError);
  });

  it("rejects batches larger than the cap", () => {
    const oversized = Array.from({ length: BATCH_MAX + 1 }, () => makeEnvelope());
    expect(() => validateBatch(oversized)).toThrow(ValidationError);
  });

  it("rejects a payload whose kind disagrees with the envelope", () => {
    const envelope = makeEnvelope({
      kind: "assistant_response",
      payload: { kind: "user_prompt", text: "mismatch" },
    } as unknown as Partial<import("@bematist/contracts").EventEnvelope>);
    expect(() => validateBatch([envelope])).toThrow(ValidationError);
  });

  it("validates each supported payload kind", () => {
    const envelopes = [
      makeEnvelope({
        kind: "assistant_response",
        payload: { kind: "assistant_response", text: "ok", stop_reason: null },
      }),
      makeEnvelope({
        kind: "tool_call",
        payload: {
          kind: "tool_call",
          tool_name: "bash",
          tool_input: { cmd: "ls" },
          tool_use_id: "tc-1",
        },
      }),
      makeEnvelope({
        kind: "tool_result",
        payload: {
          kind: "tool_result",
          tool_name: "bash",
          tool_output: "ok",
          tool_use_id: "tc-1",
          is_error: false,
        },
      }),
      makeEnvelope({
        kind: "session_start",
        payload: { kind: "session_start", source_session_id: "src-1" },
      }),
      makeEnvelope({
        kind: "session_end",
        payload: { kind: "session_end", source_session_id: "src-1", reason: null },
      }),
    ];
    const result = validateBatch(envelopes);
    expect(result.length).toBe(envelopes.length);
  });
});

import { describe, expect, it } from "bun:test";
import { ZERO_USAGE } from "./parseRollout";
import { TokenDiffer } from "./tokenDiff";

describe("TokenDiffer", () => {
  it("returns full value as delta on first observation", () => {
    const d = new TokenDiffer();
    const { delta } = d.observe({
      input_tokens: 100,
      output_tokens: 50,
      cached_input_tokens: 25,
      total_tokens: 150,
    });
    expect(delta).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cached_input_tokens: 25,
      total_tokens: 150,
    });
  });

  it("diffs against prior cumulative snapshot", () => {
    const d = new TokenDiffer();
    d.observe({
      input_tokens: 1200,
      output_tokens: 300,
      cached_input_tokens: 400,
      total_tokens: 1500,
    });
    const { delta } = d.observe({
      input_tokens: 2100,
      output_tokens: 500,
      cached_input_tokens: 800,
      total_tokens: 2600,
    });
    expect(delta).toEqual({
      input_tokens: 900,
      output_tokens: 200,
      cached_input_tokens: 400,
      total_tokens: 1100,
    });
  });

  it("treats out-of-order (decreasing) snapshots as zero-delta without rewinding cumulative", () => {
    const d = new TokenDiffer();
    d.observe({
      input_tokens: 2000,
      output_tokens: 500,
      cached_input_tokens: 400,
      total_tokens: 2500,
    });
    const { delta, cumulative } = d.observe({
      input_tokens: 1000,
      output_tokens: 200,
      cached_input_tokens: 100,
      total_tokens: 1200,
    });
    expect(delta).toEqual(ZERO_USAGE);
    expect(cumulative.input_tokens).toBe(2000);
  });

  it("reset() restores zero cumulative state", () => {
    const d = new TokenDiffer();
    d.observe({
      input_tokens: 1000,
      output_tokens: 500,
      cached_input_tokens: 250,
      total_tokens: 1500,
    });
    d.reset();
    const { delta } = d.observe({
      input_tokens: 100,
      output_tokens: 50,
      cached_input_tokens: 25,
      total_tokens: 150,
    });
    expect(delta.input_tokens).toBe(100);
    expect(delta.total_tokens).toBe(150);
  });

  it("seeds prior cumulative via constructor for resume scenarios", () => {
    const d = new TokenDiffer({
      input_tokens: 500,
      output_tokens: 100,
      cached_input_tokens: 50,
      total_tokens: 600,
    });
    const { delta } = d.observe({
      input_tokens: 600,
      output_tokens: 150,
      cached_input_tokens: 75,
      total_tokens: 750,
    });
    expect(delta.input_tokens).toBe(100);
    expect(delta.output_tokens).toBe(50);
    expect(delta.cached_input_tokens).toBe(25);
    expect(delta.total_tokens).toBe(150);
  });
});

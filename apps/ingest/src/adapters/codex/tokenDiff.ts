import type { CodexTokenUsage } from "./parseRollout";
import { ZERO_USAGE } from "./parseRollout";

export interface DiffResult {
  delta: CodexTokenUsage;
  cumulative: CodexTokenUsage;
}

export class TokenDiffer {
  private cumulative: CodexTokenUsage;

  constructor(prior: CodexTokenUsage | null = null) {
    this.cumulative = prior ? { ...prior } : { ...ZERO_USAGE };
  }

  observe(next: CodexTokenUsage): DiffResult {
    const prior = this.cumulative;
    const delta: CodexTokenUsage = {
      input_tokens: nonNegativeDelta(next.input_tokens, prior.input_tokens),
      output_tokens: nonNegativeDelta(next.output_tokens, prior.output_tokens),
      cached_input_tokens: nonNegativeDelta(next.cached_input_tokens, prior.cached_input_tokens),
      total_tokens: nonNegativeDelta(next.total_tokens, prior.total_tokens),
    };
    if (isMonotonicallyGreaterOrEqual(next, prior)) {
      this.cumulative = { ...next };
    }
    return { delta, cumulative: { ...this.cumulative } };
  }

  reset(prior: CodexTokenUsage | null = null): void {
    this.cumulative = prior ? { ...prior } : { ...ZERO_USAGE };
  }

  snapshot(): CodexTokenUsage {
    return { ...this.cumulative };
  }
}

function nonNegativeDelta(curr: number, prior: number): number {
  const d = curr - prior;
  return d > 0 ? d : 0;
}

function isMonotonicallyGreaterOrEqual(next: CodexTokenUsage, prior: CodexTokenUsage): boolean {
  return (
    next.input_tokens >= prior.input_tokens &&
    next.output_tokens >= prior.output_tokens &&
    next.cached_input_tokens >= prior.cached_input_tokens &&
    next.total_tokens >= prior.total_tokens
  );
}

import type { EventEnvelope } from "@bematist/contracts";

export interface UploadResult {
  accepted: number;
  deduped: number;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface UploaderOptions {
  apiUrl: string;
  ingestKey: string;
  clientVersion: string;
  fetch?: FetchLike;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class UploadAuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "UploadAuthError";
    this.status = status;
  }
}

export class UploadPermanentError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`upload failed with status ${status}`);
    this.name = "UploadPermanentError";
    this.status = status;
    this.body = body;
  }
}

export class UploadRetriesExhaustedError extends Error {
  readonly cause?: unknown;
  constructor(attempts: number, cause?: unknown) {
    super(`upload failed after ${attempts} attempts`);
    this.name = "UploadRetriesExhaustedError";
    this.cause = cause;
  }
}

export class Uploader {
  private readonly apiUrl: string;
  private readonly ingestKey: string;
  private readonly clientVersion: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: UploaderOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.ingestKey = opts.ingestKey;
    this.clientVersion = opts.clientVersion;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.maxRetries = opts.maxRetries ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.maxDelayMs = opts.maxDelayMs ?? 10_000;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async upload(batch: EventEnvelope[]): Promise<UploadResult> {
    if (batch.length === 0) return { accepted: 0, deduped: 0 };
    const url = `${this.apiUrl}/v1/events`;
    const body = JSON.stringify(batch);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.ingestKey}`,
            "User-Agent": `bematist-ingest/${this.clientVersion}`,
          },
          body,
        });
        if (res.ok) {
          const parsed = (await res.json()) as Partial<UploadResult>;
          return {
            accepted: typeof parsed.accepted === "number" ? parsed.accepted : 0,
            deduped: typeof parsed.deduped === "number" ? parsed.deduped : 0,
          };
        }
        if (res.status === 401 || res.status === 403) {
          throw new UploadAuthError(res.status, await safeText(res));
        }
        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`HTTP ${res.status}`);
          if (attempt === this.maxRetries) break;
          await this.sleep(this.delayFor(attempt, res.headers.get("retry-after")));
          continue;
        }
        throw new UploadPermanentError(res.status, await safeText(res));
      } catch (err) {
        if (err instanceof UploadAuthError || err instanceof UploadPermanentError) throw err;
        lastError = err;
        if (attempt === this.maxRetries) break;
        await this.sleep(this.delayFor(attempt, null));
      }
    }
    throw new UploadRetriesExhaustedError(this.maxRetries + 1, lastError);
  }

  private delayFor(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const n = Number(retryAfter);
      if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, this.maxDelayMs);
    }
    const backoff = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
    const jitter = Math.random() * (backoff * 0.25);
    return Math.min(this.maxDelayMs, Math.floor(backoff + jitter));
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

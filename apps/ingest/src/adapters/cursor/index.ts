import type { EventEnvelope } from "@bematist/contracts";
import { type Config, readConfig, writeConfig } from "../../config";
import type { Adapter, AdapterContext, EmitFn, Stop } from "../types";
import { defaultCursorHooksPath, installHooks, uninstallHooks } from "./installHooks";
import { normalize, parseHookInput } from "./normalize";
import { defaultCursorSocketAddress, startCursorSocket } from "./socket";

export interface CursorAdapterOptions {
  socketAddress?: string;
  hooksPath?: string;
  binaryPath?: string;
  configPath?: string;
  sourceVersion?: string;
  log?: (msg: string) => void;
}

export function createCursorAdapter(ctx: AdapterContext, opts: CursorAdapterOptions = {}): Adapter {
  const log = opts.log ?? (() => {});
  const seqs = new Map<string, number>();
  const seqFor = (key: string): number => {
    const n = seqs.get(key) ?? 0;
    seqs.set(key, n + 1);
    return n;
  };

  return {
    name: "cursor",
    async start(emit: EmitFn): Promise<Stop> {
      const handler = makeHandler(emit, {
        clientVersion: ctx.clientVersion,
        sourceVersion: opts.sourceVersion,
        seqFor,
      });

      const server = await startCursorSocket({
        address: opts.socketAddress ?? defaultCursorSocketAddress(),
        handler,
        onError: (err) => log(`cursor socket error: ${messageOf(err)}`),
      });
      log(`cursor adapter listening at ${server.address}`);

      return async () => {
        await server.close();
      };
    },
  };
}

interface HandlerCtx {
  clientVersion: string;
  sourceVersion: string | undefined;
  seqFor: (key: string) => number;
}

function makeHandler(
  emit: (e: EventEnvelope) => void,
  ctx: HandlerCtx,
): (raw: string) => { ok: true } | { ok: false; error: string } {
  return (raw: string) => {
    const input = parseHookInput(raw);
    const { event } = normalize(input, {
      clientVersion: ctx.clientVersion,
      sourceVersion: ctx.sourceVersion,
      seqFor: ctx.seqFor,
    });
    emit(event);
    return { ok: true };
  };
}

export interface ConsentPrompts {
  prompt(question: string): Promise<string>;
  print(msg: string): void;
}

export interface EnsureConsentOptions {
  configPath?: string;
  hooksPath?: string;
  binaryPath: string;
  prompts: ConsentPrompts;
  now?: () => string;
}

export interface EnsureConsentResult {
  enabled: boolean;
  promptedAt: string;
  hooksInstalled: boolean;
  backupCreated: boolean;
}

export async function ensureCursorConsent(
  opts: EnsureConsentOptions,
): Promise<EnsureConsentResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const hooksPath = opts.hooksPath ?? defaultCursorHooksPath();
  const current = await readConfig(opts.configPath);
  if (!current) throw new Error("no bm-pilot config found — run `bm-pilot login` first");

  const cursorCfg = (current.adapters.cursor ?? {}) as { enabled?: boolean; promptedAt?: string };
  if (cursorCfg.promptedAt) {
    return {
      enabled: Boolean(cursorCfg.enabled),
      promptedAt: cursorCfg.promptedAt,
      hooksInstalled: false,
      backupCreated: false,
    };
  }

  opts.prompts.print("Install Cursor hooks? bm-pilot will add entries to ~/.cursor/hooks.json.");
  const answer = (await opts.prompts.prompt("Install Cursor hooks? [Y/n] ")).trim();
  const yes = answer.length === 0 || /^y(es)?$/i.test(answer);
  const promptedAt = now();

  let hooksInstalled = false;
  let backupCreated = false;
  if (yes) {
    const r = await installHooks({ hooksPath, binaryPath: opts.binaryPath });
    hooksInstalled = r.changed;
    backupCreated = r.backupCreated;
  }

  const next: Config = {
    ...current,
    adapters: {
      ...current.adapters,
      cursor: { enabled: yes, promptedAt },
    },
  };
  await writeConfig(next, opts.configPath);

  return { enabled: yes, promptedAt, hooksInstalled, backupCreated };
}

export async function disableCursor(opts: {
  configPath?: string;
  hooksPath?: string;
  now?: () => string;
}): Promise<{ hooksRemoved: boolean }> {
  const now = opts.now ?? (() => new Date().toISOString());
  const current = await readConfig(opts.configPath);
  if (!current) return { hooksRemoved: false };
  const next: Config = {
    ...current,
    adapters: {
      ...current.adapters,
      cursor: { enabled: false, promptedAt: now() },
    },
  };
  await writeConfig(next, opts.configPath);
  const r = await uninstallHooks({ hooksPath: opts.hooksPath });
  return { hooksRemoved: r.changed };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

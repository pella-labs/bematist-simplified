import type { Adapter, AdapterContext, EmitFn, Stop } from "../types";
import { installCodexHook } from "./installHook";
import { CodexTailer } from "./tailer";

export interface CodexAdapterOptions {
  sessionsDir?: string;
  offsetsPath?: string;
  offsetsLockPath?: string;
  pollIntervalMs?: number;
  installHookOnStart?: boolean;
  log?: (msg: string) => void;
}

export function createCodexAdapter(
  ctx: AdapterContext,
  options: CodexAdapterOptions = {},
): Adapter {
  const log = options.log ?? ((msg) => console.log(msg));
  return {
    name: "codex",
    async start(emit: EmitFn): Promise<Stop> {
      if (options.installHookOnStart !== false) {
        try {
          await installCodexHook({ log });
        } catch (err) {
          log(`[codex] hook install failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const tailer = new CodexTailer({
        emit,
        clientVersion: ctx.clientVersion,
        sessionsDir: options.sessionsDir,
        offsetsPath: options.offsetsPath,
        offsetsLockPath: options.offsetsLockPath,
        pollIntervalMs: options.pollIntervalMs,
        log,
      });
      await tailer.start();
      return async () => {
        await tailer.stop();
      };
    },
  };
}

export { installCodexHook } from "./installHook";
export { parseRolloutLine } from "./parseRollout";
export { CodexTailer } from "./tailer";
export { TokenDiffer } from "./tokenDiff";

import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter, AdapterContext, EmitFn, Stop } from "../types";
import { installClaudeSessionStartHook } from "./installHook";
import { createTailer } from "./tailer";

export interface ClaudeCodeAdapterOptions {
  /** Override the watched projects directory. Default: ~/.claude/projects. */
  projectsDir?: string;
  /** Override the ingest state directory. Default: ~/.bm-pilot. */
  stateDir?: string;
  /** Override the settings.json path. Default: ~/.claude/settings.json. */
  settingsPath?: string;
  /** Skip the SessionStart hook install (tests). */
  skipInstallHook?: boolean;
  /** Polling interval for the tailer in ms. Default: 500. */
  pollIntervalMs?: number;
  log?: (msg: string) => void;
}

export function createClaudeCodeAdapter(
  ctx: AdapterContext,
  opts: ClaudeCodeAdapterOptions = {},
): Adapter {
  return {
    name: "claude-code",
    async start(emit: EmitFn): Promise<Stop> {
      const log = opts.log ?? (() => {});
      const projectsDir = opts.projectsDir ?? join(homedir(), ".claude", "projects");
      const stateDir = opts.stateDir ?? join(homedir(), ".bm-pilot");

      if (!opts.skipInstallHook) {
        try {
          const installRes = await installClaudeSessionStartHook({
            settingsPath: opts.settingsPath,
          });
          if (installRes.changed) {
            log(
              `claude-code: installed SessionStart hook at ${installRes.path}${
                installRes.backedUpTo ? ` (backup at ${installRes.backedUpTo})` : ""
              }`,
            );
          }
        } catch (err) {
          log(`claude-code: hook install failed — continuing without hook: ${msg(err)}`);
        }
      }

      const tailer = createTailer({
        projectsDir,
        stateDir,
        clientVersion: ctx.clientVersion,
        emit,
        pollIntervalMs: opts.pollIntervalMs,
        log,
      });
      await tailer.start();
      return async () => {
        await tailer.stop();
      };
    },
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

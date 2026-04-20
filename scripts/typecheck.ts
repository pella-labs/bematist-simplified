import { spawn } from "bun";

const projects: string[] = [
  "apps/web",
  "apps/api",
  "apps/ingest",
  "apps/worker",
  "packages/contracts",
  "packages/db",
  "packages/ui",
  "packages/auth",
  "packages/embed",
];

let failed = false;
for (const cwd of projects) {
  const proc = spawn({
    cmd: ["bunx", "tsc", "--noEmit"],
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`[typecheck] ${cwd} failed (exit ${code})`);
    failed = true;
  } else {
    console.log(`[typecheck] ${cwd} ok`);
  }
}

process.exit(failed ? 1 : 0);

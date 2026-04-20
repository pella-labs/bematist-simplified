import { spawn } from "bun";

const services: Array<{ name: string; cwd: string }> = [
  { name: "web", cwd: "apps/web" },
  { name: "api", cwd: "apps/api" },
];

const procs = services.map(({ name, cwd }) => {
  const proc = spawn({
    cmd: ["bun", "run", "dev"],
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, BEMATIST_SERVICE: name },
  });
  console.log(`[dev] started ${name} (pid ${proc.pid}) in ${cwd}`);
  return { name, proc };
});

const shutdown = (signal: NodeJS.Signals) => {
  for (const { name, proc } of procs) {
    console.log(`[dev] sending ${signal} to ${name}`);
    proc.kill(signal);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const results = await Promise.all(procs.map(({ proc }) => proc.exited));
const failed = results.find((code) => code !== 0);
process.exit(failed ?? 0);

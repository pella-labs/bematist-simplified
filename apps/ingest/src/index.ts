import { run } from "./cli";

const exitCode = await run({
  argv: process.argv,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env as Record<string, string | undefined>,
});

process.exit(exitCode);

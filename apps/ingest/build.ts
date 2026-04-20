import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

interface Target {
  key: string;
  triple: string;
  outfile: string;
}

const TARGETS: Target[] = [
  { key: "darwin-arm64", triple: "bun-darwin-arm64", outfile: "bematist-darwin-arm64" },
  { key: "darwin-x64", triple: "bun-darwin-x64", outfile: "bematist-darwin-x64" },
  { key: "linux-x64", triple: "bun-linux-x64", outfile: "bematist-linux-x64" },
  { key: "win32-x64", triple: "bun-windows-x64", outfile: "bematist-win32-x64.exe" },
];

const root = new URL(".", import.meta.url).pathname;
const entry = join(root, "src", "index.ts");
const distDir = join(root, "dist");

const requested = parseRequested(process.argv.slice(2));
const selected =
  requested.length === 0 ? TARGETS : TARGETS.filter((t) => requested.includes(t.key));

if (selected.length === 0) {
  console.error(
    `no matching targets — requested=${requested.join(",")}; known=${TARGETS.map((t) => t.key).join(",")}`,
  );
  process.exit(2);
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

let failed = 0;
for (const t of selected) {
  const outfile = join(distDir, t.outfile);
  console.log(`[build] ${t.key} -> ${outfile}`);
  const proc = Bun.spawn({
    cmd: ["bun", "build", "--compile", `--target=${t.triple}`, entry, `--outfile=${outfile}`],
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`[build] ${t.key} failed (exit ${code})`);
    failed++;
  } else {
    console.log(`[build] ${t.key} ok`);
  }
}

process.exit(failed === 0 ? 0 : 1);

function parseRequested(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (a.startsWith("--target=")) {
      out.push(a.slice("--target=".length));
    } else if (!a.startsWith("-")) {
      out.push(a);
    }
  }
  return out;
}

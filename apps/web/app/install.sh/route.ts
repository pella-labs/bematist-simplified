import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const dynamic = "force-static";
export const revalidate = 60;

// In the container build, the Dockerfile copies `apps/ingest/scripts/install.sh`
// to `apps/web/install-script/install.sh` so the first candidate resolves.
// In local dev, the second candidate walks up to the monorepo sibling.
const here = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  join(process.cwd(), "install-script", "install.sh"),
  join(here, "..", "..", "..", "install-script", "install.sh"),
  join(here, "..", "..", "..", "ingest", "scripts", "install.sh"),
];

async function loadScript(): Promise<string> {
  let lastErr: unknown;
  for (const p of CANDIDATES) {
    try {
      return await readFile(p, "utf8");
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("install.sh not found");
}

export async function GET(): Promise<Response> {
  const body = await loadScript();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}

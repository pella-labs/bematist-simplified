import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Must evaluate at request time: process.env.INGEST_API_PUBLIC_URL is only
// populated by Railway at runtime, not during `next build`. force-static would
// bake the build-time dummy (http://localhost:8000) into the response.
export const dynamic = "force-dynamic";

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
  const apiUrl = process.env.INGEST_API_PUBLIC_URL ?? process.env.INGEST_API_URL ?? "";
  // Substitute only the marker assignment line, not all occurrences — the
  // install.sh also references "{{API_URL}}" in the case-pattern that detects
  // the "not substituted" state, and we need that literal to survive.
  const substituted = body.replace(
    /^API_URL_TEMPLATE="\{\{API_URL\}\}"$/m,
    `API_URL_TEMPLATE="${apiUrl}"`,
  );
  return new Response(substituted, {
    status: 200,
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}

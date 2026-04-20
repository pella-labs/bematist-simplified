import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureGitSha } from "./captureGitSha";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bematist-capture-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("captureGitSha", () => {
  it("writes queue file with session id, cwd, sha, branch", async () => {
    const res = await captureGitSha({
      stdin: JSON.stringify({
        session_id: "sess-abc",
        cwd: "/repo",
        hook_event_name: "SessionStart",
      }),
      stateDir: tmp,
      resolveSha: async () => "deadbeef",
      resolveBranch: async () => "main",
      now: () => new Date("2026-04-20T00:00:00Z"),
    });
    expect(res.wrote).toBe(true);
    expect(res.reason).toBe("ok");
    const files = await readdir(join(tmp, "git-sha-queue"));
    expect(files).toContain("sess-abc.json");
    const written = JSON.parse(await readFile(res.path ?? "", "utf8"));
    expect(written).toMatchObject({
      sessionId: "sess-abc",
      cwd: "/repo",
      sha: "deadbeef",
      branch: "main",
    });
  });

  it("does not write when session_id missing", async () => {
    const res = await captureGitSha({
      stdin: JSON.stringify({ cwd: "/repo" }),
      stateDir: tmp,
      resolveSha: async () => "deadbeef",
      resolveBranch: async () => "main",
    });
    expect(res.wrote).toBe(false);
    expect(res.reason).toBe("no-session-id");
  });

  it("does not write when cwd missing", async () => {
    const res = await captureGitSha({
      stdin: JSON.stringify({ session_id: "s" }),
      stateDir: tmp,
      resolveSha: async () => "deadbeef",
      resolveBranch: async () => "main",
    });
    expect(res.wrote).toBe(false);
    expect(res.reason).toBe("no-cwd");
  });

  it("does not write when git sha resolution fails (not a repo)", async () => {
    const res = await captureGitSha({
      stdin: JSON.stringify({ session_id: "s", cwd: "/not-a-repo" }),
      stateDir: tmp,
      resolveSha: async () => null,
      resolveBranch: async () => null,
    });
    expect(res.wrote).toBe(false);
    expect(res.reason).toBe("no-sha");
  });

  it("hashes unsafe session ids for the filename", async () => {
    await mkdir(join(tmp, "git-sha-queue"), { recursive: true });
    const res = await captureGitSha({
      stdin: JSON.stringify({ session_id: "../../escape", cwd: "/repo" }),
      stateDir: tmp,
      resolveSha: async () => "abc",
      resolveBranch: async () => null,
    });
    expect(res.wrote).toBe(true);
    const files = await readdir(join(tmp, "git-sha-queue"));
    const name = files[0] ?? "";
    expect(name.endsWith(".json")).toBe(true);
    expect(name.includes("/")).toBe(false);
    expect(name.includes("..")).toBe(false);
  });

  it("returns malformed-stdin on non-JSON input", async () => {
    const res = await captureGitSha({
      stdin: "not json",
      stateDir: tmp,
      resolveSha: async () => "abc",
      resolveBranch: async () => null,
    });
    expect(res.wrote).toBe(false);
    expect(res.reason).toBe("malformed-stdin");
  });
});

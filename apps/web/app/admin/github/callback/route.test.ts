import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type BackfillDeps,
  backfillReposForInstallation,
  type GitHubRepo,
} from "../../../../lib/githubRepos";
import { type CallbackDeps, handleCallback } from "./route";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

interface Recorder {
  insertedInstallations: Array<{ orgId: string; installationId: number }>;
  backfillCalls: Array<{ orgId: string; installationId: number }>;
  existingInstall: { orgId: string; status: string } | null;
}

function makeDeps(rec: Recorder, overrides: Partial<CallbackDeps> = {}): CallbackDeps {
  const base: CallbackDeps = {
    requireSession: async () => ({
      user: { id: "user-1", email: "admin@example.com", name: "Admin" },
      org: { id: ORG_A, slug: "org-a", name: "Org A" },
      role: "admin",
    }),
    lookupInstallationOwner: async () => rec.existingInstall,
    withOrgScope: async (_orgId, fn) => {
      const fakeTx = {
        insert: () => ({
          values: (v: { orgId: string; installationId: number }) => ({
            onConflictDoUpdate: async () => {
              rec.insertedInstallations.push({
                orgId: v.orgId,
                installationId: v.installationId,
              });
            },
          }),
        }),
      } as unknown as Parameters<typeof fn>[0];
      return fn(fakeTx);
    },
    backfill: async (input) => {
      rec.backfillCalls.push(input);
      return { ok: true, count: 0 };
    },
  };
  return { ...base, ...overrides };
}

describe("admin/github/callback handleCallback", () => {
  let origAppId: string | undefined;
  let origPrivateKey: string | undefined;

  beforeEach(() => {
    origAppId = process.env.GITHUB_APP_ID;
    origPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  });
  afterEach(() => {
    if (origAppId === undefined) delete process.env.GITHUB_APP_ID;
    else process.env.GITHUB_APP_ID = origAppId;
    if (origPrivateKey === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
    else process.env.GITHUB_APP_PRIVATE_KEY = origPrivateKey;
  });

  test("missing installation_id redirects with error and skips backfill", async () => {
    const rec: Recorder = { insertedInstallations: [], backfillCalls: [], existingInstall: null };
    const res = await handleCallback(new Request("http://x/admin/github/callback"), makeDeps(rec));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("status=err");
    expect(res.headers.get("location")).toContain("Missing+installation_id");
    expect(rec.insertedInstallations).toHaveLength(0);
    expect(rec.backfillCalls).toHaveLength(0);
  });

  test("installation already linked to another org rejects", async () => {
    const rec: Recorder = {
      insertedInstallations: [],
      backfillCalls: [],
      existingInstall: { orgId: ORG_B, status: "active" },
    };
    const res = await handleCallback(
      new Request("http://x/admin/github/callback?installation_id=42"),
      makeDeps(rec),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("status=err");
    expect(res.headers.get("location")).toContain("already+linked");
    expect(rec.insertedInstallations).toHaveLength(0);
    expect(rec.backfillCalls).toHaveLength(0);
  });

  test("non-admin session is redirected to forbidden", async () => {
    const rec: Recorder = { insertedInstallations: [], backfillCalls: [], existingInstall: null };
    const res = await handleCallback(
      new Request("http://x/admin/github/callback?installation_id=42"),
      makeDeps(rec, {
        requireSession: async () => ({
          user: { id: "u", email: "x@y", name: null },
          org: { id: ORG_A, slug: "org-a", name: "Org A" },
          role: "member",
        }),
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("forbidden=admin-only");
    expect(rec.backfillCalls).toHaveLength(0);
  });

  test("happy path: inserts install row AND calls backfill with the right inputs", async () => {
    process.env.GITHUB_APP_ID = "app-1";
    process.env.GITHUB_APP_PRIVATE_KEY = "key-1";

    const rec: Recorder = { insertedInstallations: [], backfillCalls: [], existingInstall: null };
    const res = await handleCallback(
      new Request("http://x/admin/github/callback?installation_id=42"),
      makeDeps(rec),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("status=ok");
    expect(rec.insertedInstallations).toEqual([{ orgId: ORG_A, installationId: 42 }]);
    expect(rec.backfillCalls).toEqual([{ orgId: ORG_A, installationId: 42 }]);
  });

  test("real backfill wiring: listReposFn result is passed through to upsertReposFn", async () => {
    const listed: GitHubRepo[] = [
      { id: 1001, name: "demo", full_name: "org/demo", default_branch: "main" },
      { id: 1002, name: "other", full_name: "org/other", default_branch: null },
    ];
    const upsertCalls: Array<{ orgId: string; installationId: number; repos: GitHubRepo[] }> = [];

    const backfillDeps: BackfillDeps = {
      listReposFn: async () => listed,
      upsertReposFn: async (orgId, installationId, repos) => {
        upsertCalls.push({ orgId, installationId, repos });
      },
      env: { appId: "app-1", privateKey: "key-1" },
    };

    const rec: Recorder = { insertedInstallations: [], backfillCalls: [], existingInstall: null };
    const deps = makeDeps(rec, {
      backfill: backfillReposForInstallation,
      backfillDeps,
    });
    const res = await handleCallback(
      new Request("http://x/admin/github/callback?installation_id=99"),
      deps,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("status=ok");
    expect(upsertCalls).toEqual([{ orgId: ORG_A, installationId: 99, repos: listed }]);
  });

  test("GitHub list-repos throws: redirect still succeeds with status=ok and install row is written", async () => {
    const backfillDeps: BackfillDeps = {
      listReposFn: async () => {
        throw new Error("github-app:list-repos-failed:502");
      },
      upsertReposFn: async () => {
        throw new Error("upsert should not run on list error");
      },
      env: { appId: "app-1", privateKey: "key-1" },
    };

    const rec: Recorder = { insertedInstallations: [], backfillCalls: [], existingInstall: null };
    const deps = makeDeps(rec, {
      backfill: backfillReposForInstallation,
      backfillDeps,
    });
    const res = await handleCallback(
      new Request("http://x/admin/github/callback?installation_id=77"),
      deps,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("status=ok");
    expect(rec.insertedInstallations).toEqual([{ orgId: ORG_A, installationId: 77 }]);
  });

  test("missing GITHUB_APP_* envs: skip backfill silently and redirect ok", async () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;

    let upsertInvoked = false;
    const backfillDeps: BackfillDeps = {
      upsertReposFn: async () => {
        upsertInvoked = true;
      },
      // Intentionally omit listReposFn. Envs are unset, so
      // backfillReposForInstallation must short-circuit with missing-creds
      // before ever attempting to list or upsert.
    };

    const rec: Recorder = { insertedInstallations: [], backfillCalls: [], existingInstall: null };
    const resultsLog: Array<{ ok: boolean; reason?: string; count?: number }> = [];
    const deps = makeDeps(rec, {
      backfill: async (input, d) => {
        const out = await backfillReposForInstallation(input, d);
        resultsLog.push(out);
        return out;
      },
      backfillDeps,
    });
    const res = await handleCallback(
      new Request("http://x/admin/github/callback?installation_id=88"),
      deps,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("status=ok");
    expect(rec.insertedInstallations).toEqual([{ orgId: ORG_A, installationId: 88 }]);
    expect(upsertInvoked).toBe(false);
    expect(resultsLog).toEqual([{ ok: false, reason: "missing-creds" }]);
  });
});

describe("backfillReposForInstallation (unit)", () => {
  test("returns ok with count on success", async () => {
    const listed: GitHubRepo[] = [{ id: 1, name: "r", full_name: "o/r", default_branch: "main" }];
    let upsertedCount = 0;
    const result = await backfillReposForInstallation(
      { orgId: ORG_A, installationId: 10 },
      {
        listReposFn: async () => listed,
        upsertReposFn: async (_org, _iid, repos) => {
          upsertedCount = repos.length;
        },
        env: { appId: "1", privateKey: "k" },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(upsertedCount).toBe(1);
  });

  test("swallows errors and returns {ok:false, reason:'backfill-error'}", async () => {
    const result = await backfillReposForInstallation(
      { orgId: ORG_A, installationId: 10 },
      {
        listReposFn: async () => {
          throw new Error("boom");
        },
        upsertReposFn: async () => {},
        env: { appId: "1", privateKey: "k" },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("backfill-error");
  });

  test("returns {ok:false, reason:'missing-creds'} when envs unset and no injected listReposFn", async () => {
    const origId = process.env.GITHUB_APP_ID;
    const origKey = process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    try {
      const result = await backfillReposForInstallation(
        { orgId: ORG_A, installationId: 10 },
        { upsertReposFn: async () => {} },
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("missing-creds");
    } finally {
      if (origId !== undefined) process.env.GITHUB_APP_ID = origId;
      if (origKey !== undefined) process.env.GITHUB_APP_PRIVATE_KEY = origKey;
    }
  });
});

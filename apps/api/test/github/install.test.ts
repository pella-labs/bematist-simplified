import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  createInMemoryInstallationTokenCache,
  getInstallationToken,
  listInstallationRepos,
} from "../../src/github/install";

function pem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

describe("InstallationTokenCache", () => {
  it("returns null on miss", () => {
    const cache = createInMemoryInstallationTokenCache();
    expect(cache.get("1")).toBeNull();
  });

  it("returns cached token when not expired", () => {
    let t = 0;
    const cache = createInMemoryInstallationTokenCache({ clock: () => t });
    cache.set("1", "tok", 1000);
    expect(cache.get("1")).toBe("tok");
    t = 999;
    expect(cache.get("1")).toBe("tok");
  });

  it("evicts expired entries on read", () => {
    let t = 0;
    const cache = createInMemoryInstallationTokenCache({ clock: () => t });
    cache.set("1", "tok", 1000);
    t = 1001;
    expect(cache.get("1")).toBeNull();
  });

  it("delete removes entry", () => {
    const cache = createInMemoryInstallationTokenCache();
    cache.set("1", "tok", Date.now() + 10_000);
    cache.delete("1");
    expect(cache.get("1")).toBeNull();
  });
});

describe("getInstallationToken", () => {
  const privateKey = pem();

  it("mints a token via fetchFn and caches it", async () => {
    const cache = createInMemoryInstallationTokenCache();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    let callCount = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      callCount += 1;
      expect(url).toContain("/app/installations/123/access_tokens");
      expect(init?.method).toBe("POST");
      const auth = (init?.headers as Record<string, string>)?.authorization;
      expect(auth?.startsWith("Bearer ")).toBe(true);
      return new Response(JSON.stringify({ token: "ghs_xxx", expires_at: expiresAt }), {
        status: 201,
      });
    }) as unknown as typeof fetch;

    const tok1 = await getInstallationToken({
      installationId: 123,
      appId: 1,
      privateKeyPem: privateKey,
      cache,
      fetchFn,
    });
    const tok2 = await getInstallationToken({
      installationId: 123,
      appId: 1,
      privateKeyPem: privateKey,
      cache,
      fetchFn,
    });
    expect(tok1).toBe("ghs_xxx");
    expect(tok2).toBe("ghs_xxx");
    expect(callCount).toBe(1);
  });

  it("throws on non-ok response", async () => {
    const cache = createInMemoryInstallationTokenCache();
    const fetchFn = (async () =>
      new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    await expect(
      getInstallationToken({
        installationId: 7,
        appId: 1,
        privateKeyPem: privateKey,
        cache,
        fetchFn,
      }),
    ).rejects.toThrow(/install-token-failed/);
  });
});

describe("listInstallationRepos", () => {
  const privateKey = pem();

  it("paginates and returns all repos", async () => {
    const cache = createInMemoryInstallationTokenCache();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    let fetchCount = 0;
    const fetchFn = (async (url: string) => {
      fetchCount += 1;
      if (url.includes("access_tokens")) {
        return new Response(JSON.stringify({ token: "ghs_y", expires_at: expiresAt }), {
          status: 201,
        });
      }
      // Simulate a single page with 2 repos.
      const body = {
        total_count: 2,
        repositories: [
          { id: 1, name: "repo-a", full_name: "owner/repo-a", default_branch: "main" },
          { id: 2, name: "repo-b", full_name: "owner/repo-b", default_branch: null },
        ],
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const repos = await listInstallationRepos({
      installationId: 99,
      appId: 1,
      privateKeyPem: privateKey,
      cache,
      fetchFn,
    });
    expect(repos).toHaveLength(2);
    expect(repos[0]?.name).toBe("repo-a");
    expect(fetchCount).toBe(2);
  });
});

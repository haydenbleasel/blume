import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { fetchRepositoryInfo } from "../src/components/content/github-info.ts";

const originalFetch = globalThis.fetch;

/** Wrap a stub handler as the global `fetch` type the module expects. */
const asFetch = (
  handler: (url: string, init?: RequestInit) => Promise<Response>
): typeof fetch =>
  // SAFETY: fetchRepositoryInfo only invokes fetch as a plain function and
  // reads the Response; the extra statics on Bun's fetch type (e.g.
  // `preconnect`) are never touched.
  handler as typeof fetch;

/** Capture the Authorization header a lookup would put on the wire. */
const authHeaderFor = async (baseUrl: string): Promise<string | null> => {
  let sent: string | null = null;
  globalThis.fetch = asFetch((_url, init) => {
    sent = new Headers(init?.headers).get("Authorization");
    return Promise.resolve(
      Response.json({ description: null, forks_count: 0, stargazers_count: 0 })
    );
  });
  await fetchRepositoryInfo({
    baseUrl,
    owner: "acme",
    // Unique repo names per base keep results out of the shared build cache.
    repo: `token-${new URL(baseUrl).protocol.replace(":", "")}`,
    token: "secret",
  });
  return sent;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe(fetchRepositoryInfo, () => {
  it("maps the GitHub API response to stars, forks, and description", async () => {
    globalThis.fetch = asFetch(() =>
      Promise.resolve(
        Response.json({
          description: "A docs framework",
          forks_count: 42,
          stargazers_count: 1234,
        })
      )
    );

    // Unique repo names per test keep results out of the shared build cache.
    const info = await fetchRepositoryInfo({ owner: "acme", repo: "ok-repo" });

    expect(info).toEqual({
      description: "A docs framework",
      forks: 42,
      stars: 1234,
    });
  });

  it("authenticates against an https api base", async () => {
    expect(await authHeaderFor("https://api.acme.ghe.com")).toBe(
      "Bearer secret"
    );
  });

  it("withholds the token from a cleartext api base", async () => {
    // An Enterprise instance can be configured on plain HTTP; the counts are
    // still worth fetching, the bearer token is not worth transmitting.
    expect(await authHeaderFor("http://ghe.internal/api/v3")).toBeNull();
  });

  it("warns once per cleartext base when a token is withheld", async () => {
    // A private repo's card comes back bare either way; without a line in the
    // build log that is indistinguishable from a network failure.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      globalThis.fetch = asFetch(() =>
        Promise.resolve(
          Response.json({
            description: null,
            forks_count: 0,
            stargazers_count: 0,
          })
        )
      );
      const base = "http://ghe.warned/api/v3";
      await fetchRepositoryInfo({
        baseUrl: base,
        owner: "acme",
        repo: "a",
        token: "secret",
      });
      await fetchRepositoryInfo({
        baseUrl: base,
        owner: "acme",
        repo: "b",
        token: "secret",
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(base);
    } finally {
      warn.mockRestore();
    }
  });

  it("returns null on a non-ok response instead of throwing", async () => {
    globalThis.fetch = asFetch(() =>
      Promise.resolve(new Response("rate limit exceeded", { status: 403 }))
    );

    const info = await fetchRepositoryInfo({
      owner: "acme",
      repo: "rate-limited",
    });

    expect(info).toBeNull();
  });

  it("returns null when the request rejects", async () => {
    globalThis.fetch = asFetch(() => Promise.reject(new Error("offline")));

    const info = await fetchRepositoryInfo({ owner: "acme", repo: "offline" });

    expect(info).toBeNull();
  });
});

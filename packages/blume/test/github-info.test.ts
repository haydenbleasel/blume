import { afterEach, describe, expect, it } from "bun:test";

import { fetchRepositoryInfo } from "../src/components/content/github-info.ts";

const originalFetch = globalThis.fetch;

/** Wrap a stub handler as the global `fetch` type the module expects. */
const asFetch = (handler: (url: string) => Promise<Response>): typeof fetch =>
  // SAFETY: fetchRepositoryInfo only invokes fetch as a plain function and
  // reads the Response; the extra statics on Bun's fetch type (e.g.
  // `preconnect`) are never touched.
  handler as typeof fetch;

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

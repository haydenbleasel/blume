import { afterEach, describe, expect, it } from "bun:test";

import { fetchRepositoryInfo } from "../src/components/content/github-info.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe(fetchRepositoryInfo, () => {
  it("maps the GitHub API response to stars, forks, and description", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({
          description: "A docs framework",
          forks_count: 42,
          stargazers_count: 1234,
        })
      )) as unknown as typeof fetch;

    // Unique repo names per test keep results out of the shared build cache.
    const info = await fetchRepositoryInfo({ owner: "acme", repo: "ok-repo" });

    expect(info).toEqual({
      description: "A docs framework",
      forks: 42,
      stars: 1234,
    });
  });

  it("returns null on a non-ok response instead of throwing", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("rate limit exceeded", { status: 403 })
      )) as unknown as typeof fetch;

    const info = await fetchRepositoryInfo({
      owner: "acme",
      repo: "rate-limited",
    });

    expect(info).toBeNull();
  });

  it("returns null when the request rejects", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("offline"))) as unknown as typeof fetch;

    const info = await fetchRepositoryInfo({ owner: "acme", repo: "offline" });

    expect(info).toBeNull();
  });
});

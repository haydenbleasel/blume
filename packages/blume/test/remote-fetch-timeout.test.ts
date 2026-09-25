import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { githubReleasesSource } from "../src/core/sources/github-releases.ts";
import { mdxRemoteSource } from "../src/core/sources/mdx-remote.ts";
import type { SourceContext } from "../src/core/sources/types.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const ctx = async (): Promise<SourceContext> => {
  const cacheDir = await mkdtemp(join(tmpdir(), "blume-remote-timeout-"));
  dirs.push(cacheDir);
  return { cacheDir, mode: "build", projectRoot: cacheDir, refresh: true };
};

// SAFETY: the sources invoke `fetchImpl` only as a plain `(url, init)` call
// with string URLs; Bun's extra `fetch.preconnect` is never touched.
const asFetch = (
  impl: (input: string | URL, init?: RequestInit) => Promise<Response>
): typeof fetch => impl as typeof fetch;

/**
 * A server that never answers: each request records whether it carried an
 * abort signal, then fails the way fetch does once a timeout signal fires, so
 * the test sees the timeout path without waiting it out.
 */
const hangingServer = () => {
  const signals: (AbortSignal | undefined)[] = [];
  const fetchImpl = asFetch((_input, init) => {
    signals.push(init?.signal ?? undefined);
    return Promise.reject(
      new DOMException("The operation timed out.", "TimeoutError")
    );
  });
  return { fetchImpl, signals };
};

describe("remote source fetch timeouts", () => {
  it("names the stalled URL when every mdxRemote file times out", async () => {
    const { fetchImpl, signals } = hangingServer();
    const source = mdxRemoteSource(
      {
        fetchImpl,
        files: ["intro.mdx", "guide.mdx"],
        include: ["**/*.mdx"],
        name: "sdk",
        url: "https://example.com/docs",
      },
      await ctx()
    );

    await expect(source.load()).rejects.toMatchObject({
      diagnostic: {
        code: "BLUME_SOURCE_FETCH_FAILED",
        message: expect.stringMatching(
          /all 2 remote file\(s\) failed to fetch \(https:\/\/example\.com\/docs\/\w+\.mdx did not respond within 30s\)/u
        ),
      },
    });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("names the stalled tree listing in github mode", async () => {
    const { fetchImpl, signals } = hangingServer();
    const source = mdxRemoteSource(
      {
        fetchImpl,
        github: { owner: "o", path: "docs", ref: "main", repo: "r" },
        include: ["**/*.mdx"],
        name: "sdk",
      },
      await ctx()
    );

    await expect(source.load()).rejects.toMatchObject({
      diagnostic: {
        message: expect.stringContaining(
          "https://api.github.com/repos/o/r/git/trees/main?recursive=1 did not respond within 30s"
        ),
      },
    });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("keeps other fetch failures as they were", async () => {
    const fetchImpl = asFetch(() =>
      Promise.reject(new TypeError("fetch failed"))
    );
    const source = mdxRemoteSource(
      {
        fetchImpl,
        files: ["intro.mdx"],
        include: ["**/*.mdx"],
        name: "sdk",
        url: "https://example.com/docs",
      },
      await ctx()
    );

    await expect(source.load()).rejects.toMatchObject({
      diagnostic: {
        message: expect.stringContaining(
          "all 1 remote file(s) failed to fetch (fetch failed)"
        ),
      },
    });
  });

  it("warns with the stalled URL when GitHub Releases times out", async () => {
    const { fetchImpl, signals } = hangingServer();
    const source = githubReleasesSource(
      { fetchImpl, name: "changelog", owner: "acme", repo: "sdk" },
      await ctx()
    );

    const { diagnostics, entries } = await source.load();
    expect(entries).toStrictEqual([]);
    expect(diagnostics[0]?.code).toBe("BLUME_SOURCE_UNAVAILABLE");
    expect(diagnostics[0]?.message).toContain(
      "https://api.github.com/repos/acme/sdk/releases?per_page=100&page=1 did not respond within 30s"
    );
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});

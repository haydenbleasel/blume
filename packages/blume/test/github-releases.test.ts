import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { dirname, join } from "pathe";

import { generateRuntime } from "../src/astro/generate.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { githubReleasesSource } from "../src/core/sources/github-releases.ts";
import { normalizeEntry } from "../src/core/sources/normalize.ts";
import { resolveSources } from "../src/core/sources/resolve.ts";
import type { SourceContext } from "../src/core/sources/types.ts";
import type { ProjectContext } from "../src/core/types.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-releases-"));
  dirs.push(dir);
  return dir;
};

const ctxFor = (cacheDir: string, refresh = true): SourceContext => ({
  cacheDir,
  mode: "build",
  projectRoot: cacheDir,
  refresh,
});

interface Release {
  body: string | null;
  created_at: string;
  draft: boolean;
  html_url: string;
  id: number;
  name: string | null;
  prerelease: boolean;
  published_at: string | null;
  tag_name: string;
}

const makeRelease = (overrides: Partial<Release>): Release => ({
  body: "- Added widgets",
  created_at: "2026-06-01T00:00:00Z",
  draft: false,
  html_url: "https://github.com/acme/sdk/releases/tag/v1.2.0",
  id: 1,
  name: "v1.2.0",
  prerelease: false,
  published_at: "2026-06-24T00:00:00Z",
  tag_name: "v1.2.0",
  ...overrides,
});

interface Call {
  auth: string | null;
  url: string;
}

/** A fetch stub that serves a fixed release payload per `page` query param. */
const releasesFetch = (
  pages: Record<number, Release[]>
): { calls: Call[]; fetchImpl: typeof fetch } => {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const page = Number(url.match(/[?&]page=(?<n>\d+)/u)?.groups?.n ?? "1");
    const headers = init?.headers as Headers | undefined;
    calls.push({ auth: headers?.get("Authorization") ?? null, url });
    return Promise.resolve({
      json: () => Promise.resolve(pages[page] ?? []),
      ok: true,
      status: 200,
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

const failingFetch: typeof fetch = (() =>
  Promise.resolve({
    ok: false,
    status: 404,
    text: () => Promise.resolve(""),
  } as unknown as Response)) as unknown as typeof fetch;

describe("githubReleasesSource", () => {
  it("watch polls fresh past the dev cache and fires on a new release", async () => {
    let version = 0;
    const fetchImpl = (() => {
      version += 1;
      return Promise.resolve({
        json: () =>
          Promise.resolve([
            makeRelease({ id: version, tag_name: `v${version}.0.0` }),
          ]),
        ok: true,
        status: 200,
      } as unknown as Response);
    }) as unknown as typeof fetch;
    const source = githubReleasesSource(
      {
        fetchImpl,
        name: "changelog",
        owner: "acme",
        pollInterval: 0.01,
        repo: "sdk",
      },
      // Dev-like context: regular loads are cache-first.
      ctxFor(await tempDir(), false)
    );
    await source.load();

    let changes = 0;
    const stop = source.watch?.(() => {
      changes += 1;
    });
    await sleep(80);
    stop?.();
    // The cache-first dev loader would have served v1 forever; the poller must
    // fetch fresh and see the new release.
    expect(changes).toBeGreaterThanOrEqual(1);
  });

  it("maps a release to a staged changelog entry", async () => {
    const { fetchImpl } = releasesFetch({
      1: [makeRelease({ body: "- Added widgets\r\n- Fixed bugs" })],
    });
    const source = githubReleasesSource(
      {
        fetchImpl,
        name: "changelog",
        owner: "acme",
        prefix: "changelog",
        repo: "sdk",
      },
      ctxFor(await tempDir())
    );

    const { entries } = await source.load();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.ref).toBe("v1-2-0.md");
    expect(entry?.body.format).toBe("md");
    // CRLF is normalized to LF.
    expect(entry?.body.text).toBe("- Added widgets\n- Fixed bugs");
    expect(entry?.data).toMatchObject({
      changelog: { category: "Release", version: "1.2.0" },
      date: "2026-06-24T00:00:00Z",
      title: "v1.2.0",
      type: "changelog",
    });
    expect(entry?.raw).toContain("type: changelog");
    expect(entry?.editUrl).toBe(
      "https://github.com/acme/sdk/releases/tag/v1.2.0"
    );
    expect(entry?.lastModified).toBe("2026-06-24T00:00:00Z");
  });

  it("derives a unique seo.description from the release notes", async () => {
    const body = [
      "### Patch Changes",
      "",
      "- cf8fa22: Fix the spacing inside directive callouts (`:::note`). The global prose paragraph rule leaks a 1rem margin onto the callout's paragraphs even though the callout is `not-prose`.",
      "- bb5944d: Gate the [language icon](https://example.com/docs) on `data-language`.",
    ].join("\n");
    const { fetchImpl } = releasesFetch({ 1: [makeRelease({ body })] });
    const source = githubReleasesSource(
      { fetchImpl, name: "changelog", owner: "acme", repo: "sdk" },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    const meta = entries[0]?.data as { seo?: { description?: string } };
    const description = meta.seo?.description ?? "";
    // The section heading and changeset hash prefixes are noise, not summary.
    expect(description).toStartWith("Fix the spacing inside directive");
    expect(description).not.toContain("Patch Changes");
    expect(description).not.toContain("cf8fa22");
    // Trimmed to the audit's snippet range at a word boundary.
    expect(description.length).toBeGreaterThanOrEqual(110);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(description).toEndWith("…");
    // The description rides the frontmatter into the cached raw entry.
    expect(entries[0]?.raw).toContain("seo:");
  });

  it("keeps a short body as-is and omits seo for an empty one", async () => {
    const { fetchImpl } = releasesFetch({
      1: [
        makeRelease({ body: "- abc1234: Added widgets", id: 1 }),
        makeRelease({ body: "  ", id: 2, tag_name: "v1.1.0" }),
      ],
    });
    const source = githubReleasesSource(
      { fetchImpl, name: "changelog", owner: "acme", repo: "sdk" },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    const short = entries[0]?.data as { seo?: { description?: string } };
    expect(short.seo?.description).toBe("Added widgets");
    const empty = entries[1]?.data as { seo?: { description?: string } };
    expect(empty.seo).toBeUndefined();
  });

  it("hard-cuts a description whose word boundary falls under the minimum", async () => {
    const body = `Fix ${"a".repeat(200)}`;
    const { fetchImpl } = releasesFetch({ 1: [makeRelease({ body })] });
    const source = githubReleasesSource(
      { fetchImpl, name: "changelog", owner: "acme", repo: "sdk" },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    const meta = entries[0]?.data as { seo?: { description?: string } };
    const description = meta.seo?.description ?? "";
    expect(description.length).toBe(160);
    expect(description).toEndWith("…");
  });

  it("normalizes into a staged /changelog/<version> page", async () => {
    const { fetchImpl } = releasesFetch({ 1: [makeRelease({})] });
    const source = githubReleasesSource(
      {
        fetchImpl,
        name: "changelog",
        owner: "acme",
        prefix: "changelog",
        repo: "sdk",
      },
      ctxFor(await tempDir())
    );
    const loaded = await source.load();
    const [entry] = loaded.entries;
    if (!entry) {
      throw new Error("expected a release entry");
    }
    const { pages } = normalizeEntry(entry, {
      defaultType: "doc",
      source: { name: "changelog", prefix: "changelog", staged: true },
    });
    expect(pages[0]?.contentType).toBe("changelog");
    expect(pages[0]?.route).toBe("/changelog/v1-2-0");
    expect(pages[0]?.collection).toBe("staged");
    expect(pages[0]?.entryId).toBe("changelog/v1-2-0.md");
  });

  it("excludes drafts and prereleases by default", async () => {
    const { fetchImpl } = releasesFetch({
      1: [
        makeRelease({ id: 1, tag_name: "v1.0.0" }),
        makeRelease({ id: 2, prerelease: true, tag_name: "v1.1.0-rc.1" }),
        makeRelease({ draft: true, id: 3, tag_name: "v0.9.0" }),
      ],
    });
    const source = githubReleasesSource(
      { fetchImpl, name: "changelog", owner: "acme", repo: "sdk" },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    expect(entries.map((e) => e.ref)).toStrictEqual(["v1-0-0.md"]);
  });

  it("includes drafts and prereleases when opted in", async () => {
    const { fetchImpl } = releasesFetch({
      1: [
        makeRelease({ id: 1, tag_name: "v1.0.0" }),
        makeRelease({ id: 2, prerelease: true, tag_name: "v1.1.0-rc.1" }),
        makeRelease({ draft: true, id: 3, tag_name: "v0.9.0" }),
      ],
    });
    const source = githubReleasesSource(
      {
        drafts: true,
        fetchImpl,
        name: "changelog",
        owner: "acme",
        prereleases: true,
        repo: "sdk",
      },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    expect(entries).toHaveLength(3);
    const rc = entries.find((e) => e.ref === "v1-1-0-rc-1.md");
    const meta = rc?.data as { changelog: { category: string } };
    expect(meta.changelog.category).toBe("Prerelease");
  });

  it("paginates until a short page and honors the limit", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      makeRelease({ id: i + 1, tag_name: `v1.0.${i}` })
    );
    const { calls, fetchImpl } = releasesFetch({
      1: page1,
      2: [makeRelease({ id: 101, tag_name: "v2.0.0" })],
    });
    const source = githubReleasesSource(
      { fetchImpl, limit: 150, name: "changelog", owner: "acme", repo: "sdk" },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    expect(entries).toHaveLength(101);
    expect(
      calls.map((c) => c.url.match(/[?&]page=(?<n>\d+)/u)?.groups?.n)
    ).toStrictEqual(["1", "2"]);
  });

  it("truncates to the limit on a single page", async () => {
    const { fetchImpl } = releasesFetch({
      1: [
        makeRelease({ id: 1, tag_name: "v3.0.0" }),
        makeRelease({ id: 2, tag_name: "v2.0.0" }),
        makeRelease({ id: 3, tag_name: "v1.0.0" }),
      ],
    });
    const source = githubReleasesSource(
      { fetchImpl, limit: 1, name: "changelog", owner: "acme", repo: "sdk" },
      ctxFor(await tempDir())
    );
    const { entries } = await source.load();
    expect(entries).toHaveLength(1);
  });

  it("falls back to created_at, tag title, and a release-id ref", async () => {
    const { fetchImpl } = releasesFetch({
      1: [
        makeRelease({
          body: null,
          created_at: "2026-01-01T00:00:00Z",
          id: 7,
          name: "",
          published_at: null,
          tag_name: "@@@",
        }),
      ],
    });
    const source = githubReleasesSource(
      { fetchImpl, name: "changelog", owner: "acme", repo: "sdk" },
      ctxFor(await tempDir())
    );
    const loaded = await source.load();
    const [entry] = loaded.entries;
    expect(entry?.ref).toBe("release-7.md");
    expect(entry?.body.text).toBe("");
    expect(entry?.data).toMatchObject({
      date: "2026-01-01T00:00:00Z",
      title: "@@@",
    });
  });

  it("sends a bearer token from GITHUB_TOKEN, and omits it otherwise", async () => {
    const original = process.env.GITHUB_TOKEN;
    try {
      process.env.GITHUB_TOKEN = "t0ken";
      const withToken = releasesFetch({ 1: [makeRelease({})] });
      await githubReleasesSource(
        {
          fetchImpl: withToken.fetchImpl,
          name: "changelog",
          owner: "acme",
          repo: "sdk",
        },
        ctxFor(await tempDir())
      ).load();
      expect(withToken.calls[0]?.auth).toBe("Bearer t0ken");

      delete process.env.GITHUB_TOKEN;
      const noToken = releasesFetch({ 1: [makeRelease({})] });
      await githubReleasesSource(
        {
          fetchImpl: noToken.fetchImpl,
          name: "changelog",
          owner: "acme",
          repo: "sdk",
        },
        ctxFor(await tempDir())
      ).load();
      expect(noToken.calls[0]?.auth).toBeNull();
    } finally {
      if (original === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = original;
      }
    }
  });

  it("targets a custom baseUrl (GitHub Enterprise)", async () => {
    const { calls, fetchImpl } = releasesFetch({ 1: [makeRelease({})] });
    await githubReleasesSource(
      {
        baseUrl: "https://ghe.example/api/v3/",
        fetchImpl,
        name: "changelog",
        owner: "acme",
        repo: "sdk",
      },
      ctxFor(await tempDir())
    ).load();
    expect(calls[0]?.url).toBe(
      "https://ghe.example/api/v3/repos/acme/sdk/releases?per_page=100&page=1"
    );
  });

  it("degrades to an empty changelog with a warning when the API fails and no cache exists", async () => {
    const source = githubReleasesSource(
      {
        fetchImpl: failingFetch,
        name: "changelog",
        owner: "acme",
        repo: "sdk",
      },
      ctxFor(await tempDir())
    );
    const result = await source.load();
    expect(result.entries).toHaveLength(0);
    expect(result.diagnostics[0]?.code).toBe("BLUME_SOURCE_UNAVAILABLE");
    expect(result.diagnostics[0]?.severity).toBe("warning");
    // read() is safe after a failed load.
    expect(await source.read?.("anything.md")).toBe("");
  });

  it("serves the cached snapshot when a later fetch fails", async () => {
    const cacheDir = await tempDir();
    const { fetchImpl } = releasesFetch({ 1: [makeRelease({})] });
    await githubReleasesSource(
      { fetchImpl, name: "changelog", owner: "acme", repo: "sdk" },
      ctxFor(cacheDir)
    ).load();

    const offline = await githubReleasesSource(
      {
        fetchImpl: failingFetch,
        name: "changelog",
        owner: "acme",
        repo: "sdk",
      },
      ctxFor(cacheDir)
    ).load();
    expect(offline.entries).toHaveLength(1);
    expect(offline.diagnostics[0]?.code).toBe("BLUME_SOURCE_OFFLINE");
  });

  it("reads a body from the live snapshot and the cache", async () => {
    const cacheDir = await tempDir();
    const { fetchImpl } = releasesFetch({ 1: [makeRelease({})] });
    const source = githubReleasesSource(
      { fetchImpl, name: "changelog", owner: "acme", repo: "sdk" },
      ctxFor(cacheDir)
    );
    await source.load();
    expect(await source.read?.("v1-2-0.md")).toContain("type: changelog");
    expect(await source.read?.("missing.md")).toBe("");

    // A fresh instance (empty in-memory snapshot) reads from the cache file.
    const reopened = githubReleasesSource(
      {
        fetchImpl: failingFetch,
        name: "changelog",
        owner: "acme",
        repo: "sdk",
      },
      ctxFor(cacheDir)
    );
    expect(await reopened.read?.("v1-2-0.md")).toContain("type: changelog");
    expect(await reopened.read?.("missing.md")).toBe("");
  });

  it("attaches a polling watcher only when pollInterval is set", async () => {
    const { fetchImpl } = releasesFetch({ 1: [makeRelease({})] });
    const opts = { fetchImpl, name: "changelog", owner: "acme", repo: "sdk" };
    const ctx = ctxFor(await tempDir());
    expect(githubReleasesSource(opts, ctx).watch).toBeUndefined();
    expect(
      typeof githubReleasesSource({ ...opts, pollInterval: 30 }, ctx).watch
    ).toBe("function");
  });
});

describe("resolveSources (github-releases)", () => {
  it("wires a github-releases config into a staged source without loading", () => {
    const config = blumeConfigSchema.parse({
      content: {
        sources: [
          { root: "docs", type: "filesystem" },
          {
            owner: "haydenbleasel",
            prefix: "changelog",
            repo: "blume",
            type: "github-releases",
          },
        ],
      },
    });
    const context = {
      contentRoot: "/p/docs",
      outDir: "/p/.blume",
      root: "/p",
    } as ProjectContext;

    const sources = resolveSources(config, context, { mode: "build" });
    expect(sources).toHaveLength(2);
    expect(sources[1]?.name).toBe("changelog");
    expect(sources[1]?.staged).toBe(true);
    expect(sources[1]?.prefix).toBe("changelog");
  });
});

describe("generateRuntime with a staged changelog source", () => {
  it("makes the changelog page read the staged collection", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-staged-cl-"));
    dirs.push(root);
    const files: Record<string, string> = {
      "blume.config.ts": `export default {
  content: {
    sources: [
      { root: "docs", type: "filesystem" },
      {
        source: {
          load: () =>
            Promise.resolve({
              diagnostics: [],
              entries: [
                {
                  body: { format: "md", text: "- Shipped it\\n" },
                  data: { changelog: { version: "1.0.0" }, date: "2026-06-01", title: "v1.0.0", type: "changelog" },
                  raw: "---\\ntitle: v1.0.0\\ntype: changelog\\ndate: 2026-06-01\\n---\\n- Shipped it\\n",
                  ref: "v1-0-0.md",
                },
              ],
            }),
          name: "changelog",
          prefix: "changelog",
          staged: true,
        },
        type: "custom",
      },
    ],
  },
};
`,
      "docs/index.md": "# Home\n",
    };
    await Promise.all(
      Object.entries(files).map(async ([rel, content]) => {
        const abs = join(root, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
      })
    );

    const project = await scanProject(root, { mode: "build" });
    await generateRuntime(project);
    const changelog = join(project.context.outDir, "src/pages/changelog.astro");
    expect(existsSync(changelog)).toBe(true);
    const source = await readFile(changelog, "utf-8");
    expect(source).toContain('...(await getCollection("staged")),');
  });

  it("still generates the /changelog page when the releases source yields nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-empty-cl-"));
    dirs.push(root);
    const files: Record<string, string> = {
      "blume.config.ts": `export default {
  content: {
    sources: [
      { root: "docs", type: "filesystem" },
      { owner: "acme", prefix: "changelog", repo: "sdk", type: "github-releases" },
    ],
  },
};
`,
      "docs/index.md": "# Home\n",
    };
    await Promise.all(
      Object.entries(files).map(async ([rel, content]) => {
        const abs = join(root, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
      })
    );

    // The releases API returns no releases, so the source materializes nothing —
    // the page must still be generated so its nav tab does not 404.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve({
        json: () => Promise.resolve([]),
        ok: true,
        status: 200,
      } as unknown as Response)) as unknown as typeof fetch;
    try {
      const project = await scanProject(root, { mode: "build" });
      await generateRuntime(project);
      const changelog = join(
        project.context.outDir,
        "src/pages/changelog.astro"
      );
      expect(existsSync(changelog)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

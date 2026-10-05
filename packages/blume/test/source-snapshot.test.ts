import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

import { join } from "pathe";

import { BlumeError } from "../src/core/diagnostics.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { BlumeConfigInput } from "../src/core/schema.ts";
import { contentfulSource } from "../src/core/sources/contentful.ts";
import { githubReleasesSource } from "../src/core/sources/github-releases.ts";
import type { JsonValue } from "../src/core/sources/json.ts";
import { mdxRemoteSource } from "../src/core/sources/mdx-remote.ts";
import { normalizeEntry } from "../src/core/sources/normalize.ts";
import { notionSource } from "../src/core/sources/notion.ts";
import { payloadSource } from "../src/core/sources/payload.ts";
import { resolveSources, snapshotKey } from "../src/core/sources/resolve.ts";
import type { SourceRuntime } from "../src/core/sources/resolve.ts";
import { sanitySource } from "../src/core/sources/sanity.ts";
import type { SanityClientLike } from "../src/core/sources/sanity.ts";
import { strapiSource } from "../src/core/sources/strapi.ts";
import type {
  ContentSource,
  SourceContext,
  SourceEntry,
} from "../src/core/sources/types.ts";
import type { ProjectContext } from "../src/core/types.ts";
import { contentful, custom, mdxRemote, sanity } from "../src/sources/index.ts";
import {
  cleanupTempDirs,
  ctxFor,
  projectContext,
  recordingFetch,
  tempDir,
  withEnv,
} from "./cms-fixtures.ts";

afterAll(cleanupTempDirs);

const PREVIEW_HOST = "https://preview.contentful.com";

/** A project context rooted in a fresh temp dir. */
const contextAt = async (): Promise<ProjectContext> => {
  const root = await tempDir("snapshot-project");
  return {
    ...projectContext,
    contentRoot: join(root, "docs"),
    outDir: join(root, ".blume"),
    root,
  };
};

/** The resolved adapter of a config holding exactly one. */
const onlyAdapter = (config: BlumeConfigInput) => {
  const [adapter] = blumeConfigSchema.parse(config).content.sources;
  if (!adapter) {
    throw new Error("expected an adapter");
  }
  return adapter;
};

/** The one source a config with one adapter resolves to. */
const onlySource = (
  config: BlumeConfigInput,
  context: ProjectContext,
  runtime: SourceRuntime
): ContentSource => {
  const [source] = resolveSources(
    blumeConfigSchema.parse(config),
    context,
    runtime
  );
  if (!source) {
    throw new Error("expected a source");
  }
  return source;
};

/** A config whose one source fetches `files` from an unreachable host. */
const remoteMdxConfig = (files: string[]): BlumeConfigInput => ({
  content: {
    sources: [mdxRemote({ files, prefix: "sdk", url: "http://127.0.0.1:1" })],
  },
});

/** An empty page of a Notion listing. */
const empty = <T>(): Promise<{
  has_more: boolean;
  next_cursor: null;
  results: T[];
}> => Promise.resolve({ has_more: false, next_cursor: null, results: [] });

/** A Sanity client whose query matches no documents. */
const emptySanity: SanityClientLike = {
  // SAFETY: the adapter reads the answer as a document list, and an empty
  // list is one whatever document type the caller names.
  fetch: () => Promise.resolve([] as never),
};

const guide = (id: string, title: string) => ({
  fields: { body: `# ${title}`, slug: "pricing", title },
  sys: { id, updatedAt: "2026-02-01T00:00:00Z" },
});

const cachedEntry = (title: string): SourceEntry => ({
  body: { format: "md", text: `# ${title}\n` },
  data: { title },
  raw: `---\ntitle: ${title}\n---\n# ${title}\n`,
  ref: `${title.toLowerCase()}.md`,
});

describe("source names", () => {
  it("name a source by its prefix as the route spells it", () => {
    for (const prefix of ["/guides", "guides/", "/guides/"]) {
      const source = onlySource(
        {
          content: {
            sources: [
              sanity({ dataset: "d", prefix, projectId: "p", query: "*" }),
            ],
          },
        },
        projectContext,
        { mode: "build" }
      );
      expect(source.name).toBe("guides");
      const { pages } = normalizeEntry(cachedEntry("Pricing"), {
        defaultType: "doc",
        source: { name: source.name, prefix: source.prefix, staged: true },
      });
      // The staged collection id and the route agree, so getEntry finds it.
      expect(pages[0]?.entryId).toBe("guides/pricing.md");
      expect(pages[0]?.route).toBe("/guides/pricing");
    }
  });

  it("fall back to the adapter kind for a prefix of only slashes", () => {
    const source = onlySource(
      {
        content: {
          sources: [
            sanity({ dataset: "d", prefix: "/", projectId: "p", query: "*" }),
          ],
        },
      },
      projectContext,
      { mode: "build" }
    );
    expect(source.name).toBe("sanity");
  });
});

const adapter = (query: string, pollInterval?: number) =>
  onlyAdapter({
    content: {
      sources: [sanity({ dataset: "d", pollInterval, projectId: "p", query })],
    },
  });

describe("snapshotKey", () => {
  it("keys by preview mode and the options that shape the fetch", () => {
    const published = snapshotKey(adapter("*"), { mode: "dev" });
    expect(published).toStartWith("published-");
    expect(snapshotKey(adapter("*"), { mode: "dev", preview: true })).toBe(
      published.replace("published-", "preview-")
    );
    expect(snapshotKey(adapter("*[_type == 'doc']"), { mode: "dev" })).not.toBe(
      published
    );
    // How often dev re-fetches doesn't change what is fetched.
    expect(snapshotKey(adapter("*", 30), { mode: "dev" })).toBe(published);
  });

  it("keys a custom() source by preview mode alone", () => {
    const parsed = onlyAdapter({
      content: {
        sources: [
          custom(
            sanitySource({
              client: emptySanity,
              dataset: "d",
              name: "guides",
              projectId: "p",
              query: "*",
            })
          ),
        ],
      },
    });
    expect(snapshotKey(parsed, { mode: "build" })).toBe("published");
    expect(snapshotKey(parsed, { mode: "dev", preview: true })).toBe("preview");
  });
});

describe("preview and published snapshots", () => {
  it("never serves a preview snapshot to a published load", async () => {
    const context = await contextAt();
    let down = false;
    const { calls, fetchImpl } = recordingFetch((call) => {
      if (down) {
        return new Response("", { status: 503, statusText: "Unavailable" });
      }
      const draft = call.url.origin === PREVIEW_HOST;
      return {
        items: [guide("g1", draft ? "Draft" : "Published")],
        total: 1,
      };
    });
    const config = {
      content: {
        sources: [
          custom(
            contentfulSource({
              contentType: "guide",
              fetchImpl,
              name: "guides",
              previewToken: "preview",
              space: "s",
              token: "delivery",
            })
          ),
        ],
      },
    };
    const titles = async (runtime: SourceRuntime): Promise<string[]> => {
      const { entries } = await onlySource(config, context, runtime).load();
      return entries.map((item) => String(item.data.title));
    };

    // `blume dev --preview`: the custom() source reads drafts through the
    // Preview API and snapshots them apart from published content.
    expect(await titles({ mode: "dev", preview: true })).toStrictEqual([
      "Draft",
    ]);
    expect(calls.at(-1)?.url.origin).toBe(PREVIEW_HOST);
    expect(
      existsSync(join(context.outDir, "cache/guides/preview/entries.json"))
    ).toBe(true);

    // A build whose fetch fails has no published snapshot to fall back on,
    // and must not publish the drafts instead.
    down = true;
    await expect(titles({ mode: "build" })).rejects.toThrow(
      "no cache is available"
    );

    // A plain `blume dev` fetches published content rather than serving the
    // cached drafts.
    down = false;
    expect(await titles({ mode: "dev" })).toStrictEqual(["Published"]);
    expect(calls.at(-1)?.url.origin).toBe("https://cdn.contentful.com");

    // And `blume dev --preview` again is served its own snapshot, cache-first.
    const fetched = calls.length;
    expect(await titles({ mode: "dev", preview: true })).toStrictEqual([
      "Draft",
    ]);
    expect(calls).toHaveLength(fetched);
  });

  it("misses the cache when a source's options change", async () => {
    const context = await contextAt();
    const cacheDir = join(
      context.outDir,
      "cache/sdk",
      snapshotKey(onlyAdapter(remoteMdxConfig(["intro.mdx"])), { mode: "dev" })
    );
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, "entries.json"),
      JSON.stringify([cachedEntry("Intro")])
    );

    const loaded = await onlySource(remoteMdxConfig(["intro.mdx"]), context, {
      mode: "dev",
    }).load();
    expect(loaded.entries.map((item) => item.ref)).toStrictEqual(["intro.md"]);

    // Other options are another result: dev fetches instead of serving the
    // snapshot the old options produced (and the unreachable host fails).
    await expect(
      onlySource(remoteMdxConfig(["guide.mdx"]), context, {
        mode: "dev",
      }).load()
    ).rejects.toThrow("no cache is available");
  });
});

describe("contentful --preview without a preview token", () => {
  it("fails with a clear error instead of serving the cached snapshot", async () => {
    const cacheDir = await tempDir("contentful-no-token");
    await writeFile(
      join(cacheDir, "entries.json"),
      JSON.stringify([cachedEntry("Stale")])
    );
    const { calls, fetchImpl } = recordingFetch(() => ({
      items: [],
      total: 0,
    }));
    const sourceFor = (refresh: boolean) =>
      contentfulSource(
        { contentType: "doc", fetchImpl, name: "g", space: "s" },
        ctxFor(cacheDir, { preview: true, refresh })
      );
    await withEnv("CONTENTFUL_PREVIEW_TOKEN", undefined, async () => {
      // Cache-first dev and a refreshing build alike.
      await expect(sourceFor(false).load()).rejects.toBeInstanceOf(BlumeError);
      await expect(sourceFor(true).load()).rejects.toMatchObject({
        diagnostic: { code: "BLUME_SOURCE_MISCONFIGURED" },
        message: expect.stringContaining("needs a Preview API token"),
      });
    });
    expect(calls).toHaveLength(0);
  });

  it("stops the adapter's scan too", async () => {
    const source = onlySource(
      {
        content: { sources: [contentful({ contentType: "doc", space: "s" })] },
      },
      await contextAt(),
      { mode: "dev", preview: true }
    );
    await withEnv("CONTENTFUL_PREVIEW_TOKEN", undefined, async () => {
      await expect(source.load()).rejects.toThrow("needs a Preview API token");
    });
  });
});

describe("custom() sources on the scan's context", () => {
  // Each engine factory built the way `custom()` receives it (the ones that
  // require a context get a throwaway one), answering an empty listing.
  const { fetchImpl } = recordingFetch((call): JsonValue | Response => {
    if (call.url.pathname.endsWith("/releases")) {
      return [];
    }
    if (call.url.pathname.startsWith("/api/guides")) {
      return { data: [], docs: [], hasNextPage: false };
    }
    if (call.url.pathname.endsWith(".md")) {
      return new Response("# A\n");
    }
    return { items: [], total: 0 };
  });
  const builders = {
    contentful: () =>
      contentfulSource({
        contentType: "guide",
        fetchImpl,
        name: "g",
        space: "s",
        token: "t",
      }),
    githubReleases: (detached) =>
      githubReleasesSource(
        { fetchImpl, name: "g", owner: "o", repo: "r" },
        detached
      ),
    mdxRemote: (detached) =>
      mdxRemoteSource(
        {
          fetchImpl,
          files: ["a.md"],
          include: ["**/*.md"],
          name: "g",
          url: "https://example.com",
        },
        detached
      ),
    notion: () =>
      notionSource({
        client: {
          blocks: { children: { list: () => empty() } },
          dataSources: { query: () => empty() },
          databases: {
            retrieve: () =>
              Promise.resolve({ data_sources: [{ id: "ds", name: "D" }] }),
          },
        },
        database: "db",
        name: "g",
      }),
    payload: () =>
      payloadSource({
        collection: "guides",
        fetchImpl,
        name: "g",
        url: "https://cms.example.com",
      }),
    sanity: () =>
      sanitySource({
        client: emptySanity,
        dataset: "d",
        name: "g",
        projectId: "p",
        query: "*",
      }),
    strapi: () =>
      strapiSource({
        contentType: "guides",
        fetchImpl,
        name: "g",
        url: "https://cms.example.com",
      }),
  } satisfies Record<string, (detached: SourceContext) => ContentSource>;

  for (const [factory, build] of Object.entries(builders)) {
    it(`rebuilds a ${factory} source on the context it is handed`, async () => {
      const detached = ctxFor(await tempDir(`custom-${factory}-detached`));
      const cacheDir = await tempDir(`custom-${factory}`);
      const bound = build(detached).withContext?.(
        ctxFor(cacheDir, { refresh: true })
      );
      await bound?.load();
      expect(existsSync(join(cacheDir, "entries.json"))).toBe(true);
      expect(existsSync(join(detached.cacheDir, "entries.json"))).toBe(false);
    });
  }
});

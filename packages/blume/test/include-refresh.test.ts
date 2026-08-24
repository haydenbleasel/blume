import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import type { LoaderContext } from "astro/loaders";
import { dirname, join } from "pathe";

import { withIncludeRefresh } from "../src/astro/include-refresh.ts";

type StoreEntry = Parameters<LoaderContext["store"]["set"]>[0];

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const fixture = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-include-refresh-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return root;
};

/** A fake loader context: recording store, real root, transparent digest. */
const fakeContext = (root: string, options: { refuse?: boolean } = {}) => {
  const entries: StoreEntry[] = [];
  const assetImports: [string[], string][] = [];
  const moduleImports: string[] = [];
  const existing = new Map<string, StoreEntry>();
  const store = {
    addAssetImports: (assets: string[], file: string) => {
      assetImports.push([assets, file]);
    },
    addModuleImport: (file: string) => {
      moduleImports.push(file);
    },
    clear: () => existing.clear(),
    delete: (key: string) => {
      existing.delete(key);
    },
    entries: () => [...existing.entries()],
    get: (key: string) => existing.get(key),
    has: (key: string) => existing.has(key),
    keys: () => [...existing.keys()],
    set: (entry: StoreEntry) => {
      entries.push(entry);
      return options.refuse !== true;
    },
    values: () => [...existing.values()],
  };
  // SAFETY: the wrapper touches only store/config/generateDigest; the fake
  // covers the full scoped-store surface plus those two members.
  const context = {
    config: { root: pathToFileURL(`${root}/`) },
    generateDigest: (input: Parameters<LoaderContext["generateDigest"]>[0]) =>
      `digest(${String(input).trim()})`,
    store: store as LoaderContext["store"],
  } as LoaderContext;
  return { assetImports, context, entries, existing, moduleImports };
};

/** Run one `store.set` through the wrapped loader and return its digest. */
const setThrough = async (
  context: LoaderContext,
  graphPath: string,
  entry: StoreEntry
): Promise<StoreEntry> => {
  let seen: StoreEntry | undefined;
  const loader = withIncludeRefresh(
    {
      load: (inner: LoaderContext) => {
        inner.store.set(entry);
        seen = inner.store.get("probe");
        return Promise.resolve();
      },
      name: "glob-loader",
    },
    graphPath
  );
  await loader.load(context);
  if (seen !== undefined) {
    throw new Error("unexpected existing entry");
  }
  return entry;
};

/** An include-bearing entry for the unknown-edges fallback tests. */
const unknownEdgesEntry = (id: string, filePath?: string): StoreEntry => ({
  body: "<include>./_s.md</include>",
  data: {},
  digest: "raw",
  filePath,
  id,
});

describe("withIncludeRefresh", () => {
  it("suffixes include-bearing digests with the partials' content digest", async () => {
    const root = await fixture({ "docs/_s.md": "Tip v1.\n" });
    const page = join(root, "docs", "index.md");
    const graphPath = join(root, "includes.json");
    await writeFile(
      graphPath,
      JSON.stringify({ [join(root, "docs", "_s.md")]: [page] })
    );
    const { context, entries } = fakeContext(root);

    const body = "# Home\n\n<include>./_s.md</include>";
    await setThrough(context, graphPath, {
      body,
      data: {},
      digest: "raw",
      filePath: "docs/index.md",
      id: "index.md",
    });
    expect(entries[0]?.digest).toBe("raw:digest(Tip v1.)");

    // The suffix tracks the partial's *content*: an edit changes the stored
    // digest so the store accepts the fresh render instead of refusing it.
    await writeFile(join(root, "docs", "_s.md"), "Tip v2.\n");
    await setThrough(context, graphPath, {
      body,
      data: {},
      digest: "raw",
      filePath: "docs/index.md",
      id: "index.md",
    });
    expect(entries[1]?.digest).toBe("raw:digest(Tip v2.)");
  });

  it("marks a deleted partial so the digest still changes", async () => {
    const root = await fixture({});
    const page = join(root, "docs", "index.md");
    const gone = join(root, "docs", "_gone.md");
    const graphPath = join(root, "includes.json");
    await writeFile(graphPath, JSON.stringify({ [gone]: [page] }));
    const { context, entries } = fakeContext(root);
    await setThrough(context, graphPath, {
      body: "<include>./_gone.md</include>",
      data: {},
      digest: "raw",
      filePath: "docs/index.md",
      id: "index.md",
    });
    expect(entries[0]?.digest).toBe(`raw:digest(missing:${gone})`);
  });

  it("falls back to a unique token when the edges are unknown", async () => {
    const root = await fixture({});
    const graphPath = join(root, "includes.json");
    const { context, entries } = fakeContext(root);
    // No graph file at all; a page missing from the graph; no filePath.
    await setThrough(context, graphPath, unknownEdgesEntry("a", "docs/a.md"));
    await writeFile(graphPath, JSON.stringify({}));
    await setThrough(context, graphPath, unknownEdgesEntry("b", "docs/b.md"));
    await setThrough(context, graphPath, unknownEdgesEntry("c"));
    const digests = entries.map((stored) => stored.digest);
    expect(digests.every((d) => String(d).startsWith("raw:unknown-"))).toBe(
      true
    );
    // Unique per write, so a fresh render is never discarded as unchanged.
    expect(new Set(digests).size).toBe(3);
  });

  it("passes include-free and digest-less entries through untouched", async () => {
    const root = await fixture({});
    const graphPath = join(root, "includes.json");
    const { context, entries } = fakeContext(root);
    await setThrough(context, graphPath, {
      body: "plain body",
      data: {},
      digest: "raw",
      id: "plain",
    });
    await setThrough(context, graphPath, {
      body: "<include>./x</include>",
      data: {},
      id: "no-digest",
    });
    await setThrough(context, graphPath, {
      data: {},
      digest: "d",
      id: "no-body",
    });
    expect(entries.map((stored) => stored.digest)).toEqual([
      "raw",
      undefined,
      "d",
    ]);
  });

  it("replays skip side effects when the store refuses an unchanged write", async () => {
    const root = await fixture({ "docs/_s.md": "Tip.\n" });
    const page = join(root, "docs", "index.md");
    const graphPath = join(root, "includes.json");
    await writeFile(
      graphPath,
      JSON.stringify({ [join(root, "docs", "_s.md")]: [page] })
    );
    const { context, existing, assetImports, moduleImports } = fakeContext(
      root,
      { refuse: true }
    );
    existing.set("index.md", {
      assetImports: ["./hero.png"],
      data: {},
      deferredRender: true,
      digest: "raw:digest(Tip.)",
      filePath: "docs/index.md",
      id: "index.md",
    });
    await setThrough(context, graphPath, {
      body: "<include>./_s.md</include>",
      data: {},
      digest: "raw",
      filePath: "docs/index.md",
      id: "index.md",
    });
    expect(assetImports).toEqual([[["./hero.png"], "docs/index.md"]]);
    expect(moduleImports).toEqual(["docs/index.md"]);

    // An entry the store refuses without a stored filePath — or one the
    // wrapper never augmented — replays nothing.
    existing.set("bare", { data: {}, digest: "raw:x", id: "bare" });
    await setThrough(context, graphPath, {
      body: "<include>./_s.md</include>",
      data: {},
      digest: "raw",
      filePath: "docs/bare.md",
      id: "bare",
    });
    await setThrough(context, graphPath, {
      body: "plain",
      data: {},
      digest: "raw",
      id: "untouched",
    });
    expect(assetImports).toHaveLength(1);
    expect(moduleImports).toHaveLength(1);
  });
});

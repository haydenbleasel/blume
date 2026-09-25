import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { buildNavigation } from "../src/core/navigation.ts";
import { mdxRemoteSource } from "../src/core/sources/mdx-remote.ts";
import { normalizeEntry } from "../src/core/sources/normalize.ts";
import type { ContentSource } from "../src/core/sources/types.ts";
import type { Diagnostic, PageRecord } from "../src/core/types.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const FILES = new Map([
  ["01-getting-started/01-index.mdx", "---\ntitle: Getting started\n---\n"],
  ["01-getting-started/02-install.mdx", "---\ntitle: Install\n---\n"],
  ["01-getting-started/10-configure.mdx", "---\ntitle: Configure\n---\n"],
  ["02-reference.mdx", "---\ntitle: Reference\n---\n"],
]);

const BASE = "https://example.com/docs";

const serveFiles = (input: string | URL): Promise<Response> => {
  const file = FILES.get(input.toString().slice(BASE.length + 1));
  return Promise.resolve(
    file ? new Response(file) : new Response("", { status: 404 })
  );
};

// SAFETY: the source invokes `fetchImpl` only as a plain `(url, init)` call
// with string URLs; Bun's extra `fetch.preconnect` is never touched.
const fetchFiles = serveFiles as typeof fetch;

/** The pages a scan would normalize from the source, the way project-graph does. */
const pagesOf = async (source: ContentSource): Promise<PageRecord[]> => {
  const { entries } = await source.load();
  return entries.flatMap(
    (entry) =>
      normalizeEntry(entry, {
        defaultType: "doc",
        source: {
          name: source.name,
          orderedNames: source.orderedNames,
          prefix: source.prefix,
          staged: source.staged,
        },
      }).pages
  );
};

describe("mdxRemoteSource ordering prefixes", () => {
  it("drops the prefixes of remote file and folder names from routes", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "blume-mdx-remote-routes-"));
    dirs.push(cacheDir);
    const source = mdxRemoteSource(
      {
        fetchImpl: fetchFiles,
        files: [...FILES.keys()],
        include: ["**/*.mdx"],
        name: "sdk",
        prefix: "sdk",
        url: BASE,
      },
      { cacheDir, mode: "build", projectRoot: cacheDir, refresh: true }
    );

    const pages = await pagesOf(source);
    expect(pages.map((page) => page.route).toSorted()).toStrictEqual([
      "/sdk/getting-started",
      "/sdk/getting-started/configure",
      "/sdk/getting-started/install",
      "/sdk/reference",
    ]);

    // The prefixes still order the sidebar: `10-configure` after `02-install`.
    const diagnostics: Diagnostic[] = [];
    const nav = buildNavigation(pages, { diagnostics, folderMeta: new Map() });
    const titles = JSON.stringify(nav);
    expect(titles.indexOf('"Install"')).toBeLessThan(
      titles.indexOf('"Configure"')
    );
  });
});

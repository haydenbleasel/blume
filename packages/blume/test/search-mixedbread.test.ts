import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { dirname, join } from "pathe";

import { mixedbreadSearchEndpointTemplate } from "../src/astro/templates.ts";
import { scanProject } from "../src/core/project-graph.ts";
import type { MixedbreadOptions } from "../src/search/adapters/mixedbread.ts";
import { sourcePages } from "../src/search/source-pages.ts";
import type { SourcePage } from "../src/search/source-pages.ts";

/**
 * The Mixedbread endpoint links each hit to the page whose file `mxbai store
 * sync` uploaded: `sourcePages` lists the files, and the generated route maps
 * a chunk's recorded path back to one.
 */

const PKG_ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const tempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

describe("sourcePages", () => {
  it("pairs each indexable page's source file with its route and title", async () => {
    const root = await tempDir("blume-mixedbread-pages-");
    const files = {
      "docs/guides/install.md": "---\ntitle: Install\n---\n\nRun it.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nHello.\n",
      "docs/private.md":
        "---\ntitle: Private\nsearch:\n  exclude: true\n---\n\nHidden.\n",
    };
    await Promise.all(
      Object.entries(files).map(async ([path, content]) => {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content, "utf-8");
      })
    );
    const project = await scanProject(root, { mode: "build" });
    // Excluded from search, so a chunk of it links nowhere.
    expect(
      sourcePages(project).toSorted(([a], [b]) => a.localeCompare(b))
    ).toStrictEqual([
      ["docs/guides/install.md", { title: "Install", url: "/guides/install" }],
      ["docs/index.md", { title: "Home", url: "/" }],
    ]);
  });
});

/** The generated route's handler, as this test calls it. */
type SearchRoute = (context: { request: Request }) => Promise<Response>;

/** What the stubbed SDK was asked, and the chunks it answers with. */
interface MixedbreadStub {
  calls: Record<string, JsonValue>[];
  respond: (data: MixedbreadChunk[]) => void;
}
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
interface MixedbreadChunk {
  filename: string;
  generated_metadata?: { excerpt?: string } | null;
  metadata?: { file_path?: string } | null;
  text?: string;
}

const STUB = `let reply = [];
export const calls = [];
export const respond = (data) => { reply = data; };
export default class Mixedbread {
  stores = {
    search: async (params) => {
      calls.push(params);
      return { data: reply };
    },
  };
}
`;

/**
 * Write the generated route where it loads outside Astro: the secret becomes
 * a constant, the SDK a stub that records its calls, and the Blume import a
 * file URL.
 */
const loadRoute = async (
  options: MixedbreadOptions,
  pages: [string, SourcePage][]
): Promise<{ POST: SearchRoute; stub: MixedbreadStub }> => {
  const dir = await tempDir("blume-mixedbread-route-");
  const stubFile = join(dir, "mixedbread.mjs");
  await writeFile(stubFile, STUB, "utf-8");
  const source = mixedbreadSearchEndpointTemplate(options, pages)
    .replace(
      'import { getSecret } from "astro:env/server";',
      'const getSecret = (_name: string) => "test-key";'
    )
    .replace(
      'from "@mixedbread/sdk";',
      `from ${JSON.stringify(pathToFileURL(stubFile).href)};`
    )
    .replace(
      '"blume/core/request-body.ts"',
      JSON.stringify(
        pathToFileURL(join(PKG_ROOT, "src/core/request-body.ts")).href
      )
    );
  const file = join(dir, "search.ts");
  await writeFile(file, source, "utf-8");
  // SAFETY: the generated route exports its handler as `POST`, and the stub
  // module exports `calls` and `respond` as written above.
  const route = (await import(file)) as { POST: SearchRoute };
  // SAFETY: as above, for the stub module.
  const stub = (await import(stubFile)) as MixedbreadStub;
  return { POST: route.POST, stub };
};

const search = (POST: SearchRoute, query: string): Promise<Response> =>
  POST({
    request: new Request("https://docs.example/api/search", {
      body: JSON.stringify({ query }),
      method: "POST",
    }),
  });

describe("the generated Mixedbread route", () => {
  const PAGES: [string, SourcePage][] = [
    ["docs/index.md", { title: "Home", url: "/" }],
    ["docs/guides/install.md", { title: "Install", url: "/guides/install" }],
    [
      "docs/de/guides/install.md",
      { title: "Installieren", url: "/de/guides/install" },
    ],
  ];

  it("links each hit to the page its chunk's file renders, once per page", async () => {
    const { POST, stub } = await loadRoute(
      { search_options: { rerank: true }, storeId: "store_42" },
      PAGES
    );
    stub.respond([
      // Synced from a monorepo root: the page's path is the tail of it.
      {
        filename: "install.md",
        metadata: { file_path: "apps/site/docs/guides/install.md" },
        text: "Run the installer.",
      },
      // The same page's next chunk adds nothing new.
      {
        filename: "install.md",
        metadata: { file_path: "apps/site/docs/guides/install.md" },
        text: "Then restart.",
      },
      // Synced on Windows.
      {
        filename: "install.md",
        metadata: { file_path: String.raw`docs\de\guides\install.md` },
        text: "Führe den Installer aus.",
      },
      // Files no page renders, or no recorded path at all, link nowhere.
      {
        filename: "README.md",
        metadata: { file_path: "README.md" },
        text: "Repo notes.",
      },
      { filename: "orphan.md", metadata: null, text: "Uploaded by hand." },
      // An image chunk has no text, only the store's own excerpt.
      {
        filename: "index.md",
        generated_metadata: { excerpt: "A diagram." },
        metadata: { file_path: "./docs/index.md" },
      },
    ]);
    const response = await search(POST, "install");
    expect(await response.json()).toStrictEqual([
      {
        excerpt: "Run the installer.",
        title: "Install",
        url: "/guides/install",
      },
      {
        excerpt: "Führe den Installer aus.",
        title: "Installieren",
        url: "/de/guides/install",
      },
      { excerpt: "A diagram.", title: "Home", url: "/" },
    ]);
    // File metadata is always asked for, beside the site's own tuning.
    expect(stub.calls).toStrictEqual([
      {
        query: "install",
        search_options: { rerank: true, return_metadata: true },
        store_identifiers: ["store_42"],
        top_k: 8,
      },
    ]);
  });

  it("lets the options set top_k and sends no tuning it wasn't given", async () => {
    const { POST, stub } = await loadRoute(
      { storeId: "store_42", top_k: 3 },
      PAGES
    );
    stub.respond([]);
    const response = await search(POST, "install");
    expect(await response.json()).toStrictEqual([]);
    expect(stub.calls[0]).toStrictEqual({
      query: "install",
      search_options: { return_metadata: true },
      store_identifiers: ["store_42"],
      top_k: 3,
    });
  });
});

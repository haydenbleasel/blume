import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema, pageMetaSchema } from "../src/core/schema.ts";
import type { PageRecord, RouteManifestEntry } from "../src/core/types.ts";
import { buildSearchDocuments } from "../src/search/documents.ts";

let root: string;

const BODY = [
  "---",
  "title: A",
  "---",
  "# Heading",
  "",
  "Some **bold** text with a [link](/x) and `inlineCode`.",
  "",
  "A generic `Array<Item>` stays searchable.",
  "",
  "Requests cost < 5 credits each. Retries are billed separately.",
  "",
  "> Note: quota resets at midnight.",
  "",
  "```js",
  "const secret = 1;",
  "```",
  "",
].join("\n");

const page = (over: Partial<PageRecord> & Pick<PageRecord, "id">): PageRecord =>
  ({ sourcePath: join(root, over.id), ...over }) as PageRecord;

const route = (over: Partial<RouteManifestEntry>): RouteManifestEntry =>
  ({
    contentType: "doc",
    draft: false,
    hidden: false,
    id: "a.md",
    indexable: true,
    path: "/a",
    sourcePath: join(root, "a.md"),
    title: "A",
    ...over,
  }) as RouteManifestEntry;

const projectWith = (
  pages: PageRecord[],
  routes: RouteManifestEntry[]
): BlumeProject =>
  ({ graph: { pages }, manifest: { routes } }) as unknown as BlumeProject;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-search-"));
  await writeFile(join(root, "a.md"), BODY);
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("buildSearchDocuments", () => {
  it("indexes only indexable routes, in manifest order", async () => {
    const docs = await buildSearchDocuments(
      projectWith(
        [page({ description: "Desc A", id: "a.md" })],
        [
          route({ id: "a.md", path: "/a" }),
          route({ id: "a.md", indexable: false, path: "/b" }),
          route({ id: "missing.md", path: "/c", title: "C" }),
        ]
      )
    );
    expect(docs.map((doc) => doc.route)).toStrictEqual(["/a", "/c"]);
  });

  it("reduces markdown to plain text, stripping code, links, and headings", async () => {
    const [doc] = await buildSearchDocuments(
      projectWith([page({ description: "Desc A", id: "a.md" })], [route({})])
    );
    expect(doc?.title).toBe("A");
    expect(doc?.description).toBe("Desc A");
    expect(doc?.content).toContain("Heading");
    expect(doc?.content).toContain("bold");
    // Link text is kept while the URL is dropped.
    expect(doc?.content).toContain("link");
    expect(doc?.content).toContain("inlineCode");
    // Angle-bracket type params inside inline code survive the HTML strip.
    expect(doc?.content).toContain("Item");
    // Fenced code blocks are removed entirely.
    expect(doc?.content).not.toContain("secret");
    expect(doc?.content).not.toContain("#");
    // A bare `<` in prose is not a tag opener: the HTML strip must not swallow
    // everything from it to the next `>` (here, a blockquote a paragraph later).
    expect(doc?.content).toContain("5 credits each");
    expect(doc?.content).toContain("Retries are billed separately");
    expect(doc?.content).toContain("quota resets at midnight");
  });

  it("keeps Markdown and fenced code when content is 'markdown'", async () => {
    const [doc] = await buildSearchDocuments(
      projectWith([page({ description: "Desc A", id: "a.md" })], [route({})]),
      { content: "markdown" }
    );
    // The fenced example the plain extraction drops is kept for Ask AI grounding…
    expect(doc?.content).toContain("const secret = 1;");
    expect(doc?.content).toContain("```js");
    // …along with heading marks and other Markdown structure.
    expect(doc?.content).toContain("# Heading");
  });

  it("yields empty content for a route with no matching page", async () => {
    const [doc] = await buildSearchDocuments(
      projectWith([], [route({ id: "missing.md", path: "/c", title: "C" })])
    );
    expect(doc?.content).toBe("");
    expect(doc?.description).toBe("");
  });
});

// When the search provider is "none" every route is non-indexable, but the MCP
// server is a separate feature and should still index docs.
describe("buildSearchDocuments with includeWhenDisabled", () => {
  const projectNoSearch = (over: Record<string, unknown> = {}): BlumeProject =>
    ({
      config: blumeConfigSchema.parse({ search: { provider: "none" } }),
      graph: {
        pages: [
          page({
            description: "Desc A",
            id: "a.md",
            meta: pageMetaSchema.parse(over),
          }),
        ],
      },
      manifest: {
        routes: [route({ id: "a.md", indexable: false, path: "/a" })],
      },
    }) as unknown as BlumeProject;

  it("indexes nothing by default when search is disabled", async () => {
    const docs = await buildSearchDocuments(projectNoSearch());
    expect(docs).toHaveLength(0);
  });

  it("indexes content-indexable pages when the flag is set", async () => {
    const docs = await buildSearchDocuments(projectNoSearch(), {
      includeWhenDisabled: true,
    });
    expect(docs.map((doc) => doc.route)).toStrictEqual(["/a"]);
  });

  it("still honours per-page search.exclude when the flag is set", async () => {
    const docs = await buildSearchDocuments(
      projectNoSearch({ search: { exclude: true } }),
      { includeWhenDisabled: true }
    );
    expect(docs).toHaveLength(0);
  });
});

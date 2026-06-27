import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import type { BlumeProject } from "../src/core/project-graph.ts";
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
  ({
    context: { configFile: null, root },
    graph: { pages },
    manifest: { routes },
  }) as unknown as BlumeProject;

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
    // Fenced code blocks are removed entirely.
    expect(doc?.content).not.toContain("secret");
    expect(doc?.content).not.toContain("#");
  });

  it("yields empty content for a route with no matching page", async () => {
    const [doc] = await buildSearchDocuments(
      projectWith([], [route({ id: "missing.md", path: "/c", title: "C" })])
    );
    expect(doc?.content).toBe("");
    expect(doc?.description).toBe("");
  });
});

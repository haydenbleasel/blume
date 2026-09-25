import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { ContentSource } from "../src/core/sources/types.ts";
import type { PageRecord, RouteManifestEntry } from "../src/core/types.ts";
import { buildSearchDocuments } from "../src/search/documents.ts";

let root: string;

/** No API reference, so no reference serializer applies. */
const NO_SOURCES: ContentSource[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-search-directives-"));
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

/** The plain search text of one page with this body. */
const indexed = async (id: string, body: string): Promise<string> => {
  const sourcePath = join(root, id);
  await writeFile(sourcePath, `---\ntitle: T\n---\n${body}`);
  // SAFETY: `buildSearchDocuments` reads only a page's id, format, and
  // sourcePath; the remaining PageRecord fields are unused.
  const page = {
    format: id.endsWith(".mdx") ? "mdx" : "md",
    id,
    sourcePath,
  } as PageRecord;
  // SAFETY: the document builder reads only the manifest-route fields listed
  // here; the rest of RouteManifestEntry is unused.
  const route = {
    contentType: "doc",
    id,
    indexable: true,
    locale: "",
    path: "/t",
    sourcePath,
    title: "T",
    version: "",
  } as RouteManifestEntry;
  // SAFETY: `buildSearchDocuments` reads only `config`, `graph.pages`,
  // `manifest.routes`, and `sources` from the project.
  const project = {
    config: blumeConfigSchema.parse({}),
    graph: { pages: [page] },
    manifest: { routes: [route] },
    sources: NO_SOURCES,
  } as BlumeProject;
  const [doc] = await buildSearchDocuments(project);
  return doc?.content ?? "";
};

describe("search text for directive lookalikes in .mdx", () => {
  it("keeps a text directive's `:name` part, as the page renders it", async () => {
    const text = await indexed(
      "ratio.mdx",
      "A responsive 16:9 frame sets og:image at 10:30am.\n"
    );
    expect(text).toBe("A responsive 16:9 frame sets og:image at 10:30am.");
  });

  it("keeps a label and attributes, and a leaf directive as its own block", async () => {
    const text = await indexed(
      "leaf.mdx",
      "See :abbr[HTML]{title='x'} here.\n\n::youtube[clip]{id=1}\nAfter.\n"
    );
    expect(text).toBe(
      "See :abbr[HTML]{title='x'} here. ::youtube[clip]{id=1} After."
    );
  });

  it("keeps the time in a heading", async () => {
    expect(await indexed("heading.mdx", "## Office at 12:45pm\n")).toBe(
      "Office at 12:45pm"
    );
  });

  it("reads a callout's and an unknown container's body", async () => {
    const text = await indexed(
      "containers.mdx",
      ":::note[Meet at 10:30]\nBring the 16:9 deck.\n:::\n\n:::details\nHidden at 9:15.\n:::\n"
    );
    expect(text).toBe("Meet at 10:30 Bring the 16:9 deck. Hidden at 9:15.");
  });

  it("leaves .md alone — it has no directives", async () => {
    expect(await indexed("plain.md", "A 16:9 frame and ::youtube\n")).toBe(
      "A 16:9 frame and ::youtube"
    );
  });
});

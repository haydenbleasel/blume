import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";
import type { z } from "zod";

import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema, pageMetaSchema } from "../src/core/schema.ts";
import type { ResolvedConfig } from "../src/core/schema.ts";
import type { PageRecord, RouteManifestEntry } from "../src/core/types.ts";
import { buildSearchDocuments } from "../src/search/documents.ts";
import { pageFacets } from "../src/search/facets.ts";

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
  "A [reference link][ref] and 5 * 3 stars.\\",
  "after a hard break.",
  "",
  "[ref]: /elsewhere",
  "",
  '<Callout kind="warn">',
  "Callouts keep their inner prose indexed.",
  "</Callout>",
  "",
  "| Region | Latency |",
  "| ------ | ------- |",
  "| west   | 40ms    |",
  "",
].join("\n");

// SAFETY: `buildSearchDocuments` reads only a page's id, sourcePath, and the
// meta fields a test sets; the remaining PageRecord fields are unused here.
const page = (over: Partial<PageRecord> & Pick<PageRecord, "id">): PageRecord =>
  ({ sourcePath: join(root, over.id), ...over }) as PageRecord;

// SAFETY: the document builder reads only the manifest-route fields listed
// below; the rest of RouteManifestEntry is unused by these tests.
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
  // SAFETY: `buildSearchDocuments` reads only `config`, `graph.pages`, and
  // `manifest.routes` from the project.
  ({
    config: blumeConfigSchema.parse({}),
    graph: { pages },
    manifest: { routes },
  }) as BlumeProject;

const VIS_BODY = [
  "---",
  "title: V",
  "---",
  "# V",
  "",
  '<Visibility for="web">',
  "Webonly note.",
  "</Visibility>",
  "",
  '<Visibility for="agents">',
  "Agentonly note.",
  "</Visibility>",
  "",
  "```astro",
  '<Visibility for="agents">Fenced sample.</Visibility>',
  "```",
  "",
].join("\n");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-search-"));
  await writeFile(join(root, "a.md"), BODY);
  await writeFile(join(root, "vis.md"), VIS_BODY);
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

/** A resolved config with the given facet names declared for `type: rfc`. */
const configWithRfcFacets = (facets: string[]): ResolvedConfig => {
  const base = blumeConfigSchema.parse({});
  return {
    ...base,
    // Bypasses parse-time facet validation (which needs schema fixtures);
    // `pageFacets` reads only the resolved declaration.
    content: {
      ...base.content,
      types: { rfc: { facets, frontmatter: {} } },
    },
  };
};

describe("pageFacets", () => {
  it("resolves declared facets, stringifying numbers and booleans", () => {
    const facets = pageFacets(
      {
        contentType: "rfc",
        custom: {
          domain: "architecture",
          enforced: true,
          revision: 3,
          undeclared: "ignored",
        },
      },
      configWithRfcFacets(["domain", "enforced", "revision", "absent"])
    );
    expect(facets).toStrictEqual({
      domain: "architecture",
      enforced: "true",
      revision: "3",
    });
  });

  it("skips non-scalar values and returns undefined when nothing facets", () => {
    const config = configWithRfcFacets(["meta"]);
    expect(
      pageFacets(
        { contentType: "rfc", custom: { meta: { nested: 1 } } },
        config
      )
    ).toBeUndefined();
    // No custom values, an undeclared type, and no facet declaration all
    // resolve to "no facets" rather than an empty object.
    expect(pageFacets({ contentType: "rfc" }, config)).toBeUndefined();
    expect(
      pageFacets({ contentType: "doc", custom: { meta: "x" } }, config)
    ).toBeUndefined();
    expect(
      pageFacets(
        { contentType: "rfc", custom: { meta: "x" } },
        configWithRfcFacets([])
      )
    ).toBeUndefined();
  });
});

describe("buildSearchDocuments", () => {
  it("emits declared facet values and omits the field elsewhere", async () => {
    // SAFETY: `buildSearchDocuments` reads only `config`, `graph.pages`, and
    // `manifest.routes` from the project.
    const project = {
      config: configWithRfcFacets(["status"]),
      graph: {
        pages: [
          page({
            contentType: "rfc",
            custom: { status: "enforced" },
            id: "a.md",
          }),
        ],
      },
      manifest: { routes: [route({ contentType: "rfc" })] },
    } as BlumeProject;
    const [doc] = await buildSearchDocuments(project);
    expect(doc?.facets).toStrictEqual({ status: "enforced" });

    const [plain] = await buildSearchDocuments(
      projectWith([page({ id: "a.md" })], [route({})])
    );
    expect(plain && "facets" in plain).toBe(false);
  });

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
    // Reference-style link text is kept; its definition URL is dropped.
    expect(doc?.content).toContain("reference link");
    expect(doc?.content).not.toContain("/elsewhere");
    // Literal asterisks in prose are text, not emphasis to strip.
    expect(doc?.content).toContain("5 * 3 stars");
    // A block-level JSX component is one CommonMark html node: its tags go,
    // its inner prose stays indexed.
    expect(doc?.content).toContain("Callouts keep their inner prose indexed");
    expect(doc?.content).not.toContain("<Callout");
    // GFM table cells are text.
    expect(doc?.content).toContain("west");
  });

  it("strips trailing heading markers from the plain-text index", async () => {
    await writeFile(
      join(root, "markers.md"),
      [
        "# Guide",
        "",
        "## Install [#setup]",
        "",
        "## Internals [!toc]",
        "",
        "Body prose.",
        "",
      ].join("\n")
    );
    const [doc] = await buildSearchDocuments(
      projectWith(
        [page({ id: "markers.md" })],
        [route({ id: "markers.md", sourcePath: join(root, "markers.md") })]
      )
    );
    // Anchor metadata, not prose: the marker text must never be searchable.
    expect(doc?.content).toContain("Install");
    expect(doc?.content).toContain("Internals");
    expect(doc?.content).not.toContain("[#setup]");
    expect(doc?.content).not.toContain("[!toc]");
  });

  it("keeps bracketed heading text that renders on the page searchable", async () => {
    await writeFile(
      join(root, "literal.md"),
      [
        "# Guide",
        "",
        "## Using `[toc]`",
        "",
        "## [#bare]",
        "",
        "Body prose.",
        "",
      ].join("\n")
    );
    const [doc] = await buildSearchDocuments(
      projectWith(
        [page({ id: "literal.md" })],
        [route({ id: "literal.md", sourcePath: join(root, "literal.md") })]
      )
    );
    // Mirroring the renderer: a marker only counts when it ends the heading's
    // final plain-text child, so inline code stays searchable, and a
    // marker-only heading renders (and indexes) literally.
    expect(doc?.content).toContain("Using [toc]");
    expect(doc?.content).toContain("[#bare]");
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

  it("gives a config-sidebar section's landing page its own section facet", async () => {
    // A section declared via `sidebar: [{ label, root, items }]` carries its
    // landing route on the *group* node — the landing page must facet under
    // its own section, not fall through to the "Docs" default.
    const project = projectWith(
      [page({ id: "a.md" })],
      [
        route({ id: "a.md", path: "/guides", title: "Guides" }),
        route({ id: "a.md", path: "/guides/setup", title: "Setup" }),
      ]
    );
    project.graph.navigation = {
      featured: [],
      selectors: [],
      sidebar: [
        {
          children: [
            {
              kind: "page",
              label: "Setup",
              pageId: "a.md",
              route: "/guides/setup",
            },
          ],
          display: "flat",
          kind: "group",
          label: "Guides",
          route: "/guides",
        },
      ],
      tabs: [],
    };
    const docs = await buildSearchDocuments(project);
    expect(docs.find((doc) => doc.route === "/guides")?.section).toBe("Guides");
    expect(docs.find((doc) => doc.route === "/guides/setup")?.section).toBe(
      "Guides"
    );
  });

  it("yields empty content for a route with no matching page", async () => {
    const [doc] = await buildSearchDocuments(
      projectWith([], [route({ id: "missing.md", path: "/c", title: "C" })])
    );
    expect(doc?.content).toBe("");
    expect(doc?.description).toBe("");
  });
});

describe("buildSearchDocuments — <Visibility> audiences", () => {
  const visProject = (): BlumeProject =>
    projectWith(
      [page({ id: "vis.md" })],
      [
        route({
          id: "vis.md",
          path: "/vis",
          sourcePath: join(root, "vis.md"),
          title: "V",
        }),
      ]
    );

  it("web (default): keeps web-only content, drops agents-only blocks", async () => {
    // The dialog must never surface content the rendered page hides.
    const [doc] = await buildSearchDocuments(visProject());
    expect(doc?.content).toContain("Webonly note.");
    expect(doc?.content).not.toContain("Agentonly note.");
  });

  it("agents: mirrors llms-full.txt (web removed, agents unwrapped)", async () => {
    const [doc] = await buildSearchDocuments(visProject(), {
      audience: "agents",
    });
    expect(doc?.content).toContain("Agentonly note.");
    expect(doc?.content).not.toContain("Webonly note.");
  });

  it("leaves fenced samples showing the tag intact in markdown mode", async () => {
    const [doc] = await buildSearchDocuments(visProject(), {
      audience: "agents",
      content: "markdown",
    });
    expect(doc?.content).toContain(
      '<Visibility for="agents">Fenced sample.</Visibility>'
    );
    expect(doc?.content).toContain("Agentonly note.");
    expect(doc?.content).not.toContain("Webonly note.");
    // The unwrap leaves no live tags outside the fence.
    expect(doc?.content.replaceAll(/```[\s\S]*?```/gu, "")).not.toContain(
      "<Visibility"
    );
  });
});

// When the search provider is "none" every route is non-indexable, but the MCP
// server is a separate feature and should still index docs.
describe("buildSearchDocuments with includeWhenDisabled", () => {
  const projectNoSearch = (
    over: z.input<typeof pageMetaSchema> = {}
  ): BlumeProject =>
    // SAFETY: `buildSearchDocuments` reads only `config`, `graph.pages`, and
    // `manifest.routes` from the project.
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
    }) as BlumeProject;

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

  it("still honors per-page search.exclude when the flag is set", async () => {
    const docs = await buildSearchDocuments(
      projectNoSearch({ search: { exclude: true } }),
      { includeWhenDisabled: true }
    );
    expect(docs).toHaveLength(0);
  });
});

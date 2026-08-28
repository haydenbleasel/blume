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
  "Energy is E=mc^2^ here.",
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
  "![Diagram alt that should not index](./diagram.png)",
  "",
  "![Reference image alt that should not index][diagram-ref]",
  "",
  "[ref]: /elsewhere",
  "[diagram-ref]: ./diagram-ref.png",
  "",
  '<Callout kind="warn">',
  "Callouts keep their inner prose indexed.",
  "</Callout>",
  "",
  "Right after the callout.",
  "",
  "| Region | Latency |",
  "| ------ | ------- |",
  "| west   | 40ms    |",
  "",
].join("\n");

// SAFETY: `buildSearchDocuments` reads only a page's id, sourcePath, format,
// and the meta fields a test sets; the remaining PageRecord fields are unused.
const page = (over: Partial<PageRecord> & Pick<PageRecord, "id">): PageRecord =>
  ({
    format: over.id.endsWith(".mdx") ? "mdx" : "md",
    sourcePath: join(root, over.id),
    ...over,
  }) as PageRecord;

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
  routes: RouteManifestEntry[],
  config: z.input<typeof blumeConfigSchema> = {}
): BlumeProject =>
  // SAFETY: `buildSearchDocuments` reads only `config`, `graph.pages`, and
  // `manifest.routes` from the project.
  ({
    config: blumeConfigSchema.parse(config),
    graph: { pages },
    manifest: { routes },
  }) as BlumeProject;

/**
 * An MDX page in the shape real docs take: a titled top-level fence, prose and
 * a fence indented inside nested components, inline JSX, an expression, and
 * an ESM export. CommonMark would fold each component into one html node and
 * read its indented children as an indented code block.
 */
const CODE_BODY = [
  "---",
  "title: C",
  "---",
  "# Setup",
  "",
  "Prose before.",
  "",
  "```ts blume.config.ts lineNumbers",
  "export const retryPolicy = 1;",
  "```",
  "",
  "<Steps>",
  '  <Step title="Install">',
  "    Run the installer with npm.",
  "",
  "    ```bash",
  "    npm install blume",
  "",
  "    npm run dev",
  "    ```",
  "  </Step>",
  "</Steps>",
  "",
  "Press <Kbd>k</Kbd> to open {props.count} results.",
  "",
  "Press Enter<br />then wait.",
  "",
  // Formatter-wrapped card: downleveled to the text it shows.
  "<Card",
  '  title="Rate limits"',
  '  href="/limits"',
  '  icon="rocket"',
  '  cta="Read the quota guide"',
  "  meta={{ weight: 2 }}",
  "/>",
  "",
  '<TypeTable type={{ retries: { type: "number", description: "Attempts before failing." } }} />',
  "",
  "This is re:abbr[al]ly inline.",
  "",
  ":::note[Heads up]",
  "Directive prose survives.",
  ":::",
  "",
  "$$",
  "\\sum_{i=1}^n x_i",
  "$$",
  "",
  "H~2~O costs $5.",
  "",
  "export const meta = { draft: false };",
  "",
].join("\n");

/**
 * MDX rejects HTML comments (so does the renderer): the page has no body to
 * index, but its title and description still make it findable.
 */
const COMMENT_BODY = [
  "---",
  "title: D",
  "---",
  "<!-- editors: keep this list sorted -->",
  "",
  "Fallback prose survives.",
  "",
].join("\n");

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

/** A body that opens with a divider once the real front matter is stripped. */
const DIVIDER_BODY = [
  "---",
  "title: E",
  "---",
  "---",
  "",
  "After the divider **bold** [intro](/x).",
  "",
  "---",
  "",
  "More text.",
  "",
].join("\n");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-search-"));
  await writeFile(join(root, "a.md"), BODY);
  await writeFile(join(root, "vis.md"), VIS_BODY);
  await writeFile(join(root, "code.mdx"), CODE_BODY);
  await writeFile(join(root, "comment.mdx"), COMMENT_BODY);
  await writeFile(join(root, "divider.mdx"), DIVIDER_BODY);
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
    const content = doc?.content ?? "";
    expect(doc?.title).toBe("A");
    expect(doc?.description).toBe("Desc A");
    expect(content).toContain("Heading");
    expect(content).toContain("bold");
    // Link text is kept while the URL is dropped.
    expect(content).toContain("link");
    expect(content).toContain("inlineCode");
    // Angle-bracket type params inside inline code survive the HTML strip.
    expect(content).toContain("Item");
    // `.md` pages parse with the renderer's features: superscript is text.
    expect(content).toContain("E=mc2 here");
    // Code blocks are removed entirely.
    expect(content).not.toContain("secret");
    expect(content).not.toContain("#");
    // A bare `<` in prose is not a tag opener: the HTML strip must not swallow
    // everything from it to the next `>` (here, a blockquote a paragraph later).
    expect(content).toContain("5 credits each");
    expect(content).toContain("Retries are billed separately");
    expect(content).toContain("quota resets at midnight");
    // Reference-style link text is kept; its definition URL is dropped.
    expect(content).toContain("reference link");
    expect(content).not.toContain("/elsewhere");
    // Literal asterisks in prose are text, not emphasis to strip.
    expect(content).toContain("5 * 3 stars");
    // A block-level JSX component is one CommonMark html node: its tags go,
    // its inner prose stays indexed.
    expect(content).toContain("Callouts keep their inner prose indexed");
    expect(content).not.toContain("<Callout");
    // The html block ends a word: the next paragraph doesn't fuse onto it.
    expect(content).toContain("indexed. Right after the callout");
    // GFM table cells are text.
    expect(content).toContain("west");
  });

  it("skips image alt text in the plain text index", async () => {
    const [doc] = await buildSearchDocuments(
      projectWith([page({ description: "Desc A", id: "a.md" })], [route({})])
    );
    expect(doc?.content).not.toContain("Diagram alt that should not index");
    expect(doc?.content).not.toContain(
      "Reference image alt that should not index"
    );
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

  describe("MDX pages", () => {
    const mdxProject = (
      id: string,
      config: z.input<typeof blumeConfigSchema> = {}
    ) =>
      projectWith(
        [page({ id })],
        [route({ id, sourcePath: join(root, id) })],
        config
      );

    it("indexes prose inside components, however indented, and skips JSX/ESM", async () => {
      const [doc] = await buildSearchDocuments(mdxProject("code.mdx"));
      expect(doc?.content).toContain("Prose before");
      expect(doc?.content).toContain("Run the installer with npm");
      // Inline JSX keeps its text without a space break; expressions and ESM
      // are code, not prose.
      expect(doc?.content).toContain("Press k to open results");
      // The renderer's feature set applies: directives and block math parse
      // (a `{…}` inside `$$` would otherwise fail the MDX parse), and
      // sub/superscript stay attached to their word.
      expect(doc?.content).toContain("Heads up Directive prose survives");
      expect(doc?.content).not.toContain(":::");
      expect(doc?.content).not.toContain("x_i");
      expect(doc?.content).toContain("H2O costs $5");
      // An empty inline element still separates words.
      expect(doc?.content).toContain("Press Enter then wait");
      // Components downlevel to the text they show: a Card's title and call
      // to action, a TypeTable's descriptions — not hrefs, icons, or props.
      expect(doc?.content).toContain("Rate limits");
      expect(doc?.content).toContain("Read the quota guide");
      expect(doc?.content).toContain("Attempts before failing");
      expect(doc?.content).not.toContain("/limits");
      expect(doc?.content).not.toContain("rocket");
      expect(doc?.content).not.toContain("weight");
      // An inline directive is part of its word.
      expect(doc?.content).toContain("This is really inline");
      expect(doc?.content).not.toContain("props.count");
      expect(doc?.content).not.toContain("draft");
      expect(doc?.content).not.toContain("<Step");
      expect(doc?.content).not.toContain("title=");
    });

    it("strips fences everywhere by default, including inside components", async () => {
      const [doc] = await buildSearchDocuments(mdxProject("code.mdx"));
      expect(doc?.content).not.toContain("retryPolicy");
      expect(doc?.content).not.toContain("blume.config.ts");
      expect(doc?.content).not.toContain("npm install blume");
      expect(doc?.content).not.toContain("npm run dev");
      expect(doc?.content).not.toContain("```");
    });

    it("indexes fence bodies and titles when search.indexing.includeCodeBlocks is set", async () => {
      const [doc] = await buildSearchDocuments(
        mdxProject("code.mdx", {
          search: { indexing: { includeCodeBlocks: true } },
        })
      );
      expect(doc?.content).toContain("export const retryPolicy = 1;");
      // The rendered title is searchable; the language, `lineNumbers`, and
      // fence markers are not.
      expect(doc?.content).toContain("blume.config.ts");
      expect(doc?.content).not.toContain("lineNumbers");
      expect(doc?.content).not.toContain("```");
      expect(doc?.content).not.toMatch(/(?:^|\s)ts(?:\s|$)/u);
      // An indented fence inside a component (blank line and all) is one
      // block, indexed like a top-level one.
      expect(doc?.content).toContain("npm install blume npm run dev");
      expect(doc?.content).not.toContain("bash");
      expect(doc?.content).not.toContain("<Step");
    });

    it("indexes a page MDX rejects by title only, never its raw source", async () => {
      const [doc] = await buildSearchDocuments(mdxProject("comment.mdx"));
      expect(doc?.title).toBe("A");
      expect(doc?.content).toBe("");
    });

    it("reads a leading `---` as a divider, not front matter", async () => {
      const [doc] = await buildSearchDocuments(mdxProject("divider.mdx"));
      expect(doc?.content).toContain("After the divider bold intro. More text");
      expect(doc?.content).not.toContain("**");
    });
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

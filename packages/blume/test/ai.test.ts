import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { createAskContext, relevantExcerpt } from "../src/ai/ask-context.ts";
import type { AskData } from "../src/ai/ask-context.ts";
import { buildAskData } from "../src/ai/ask-data.ts";
import { askBackendRuntimeDep, resolveAskBackend } from "../src/ai/ask.ts";
import { buildLlmsFiles } from "../src/ai/llms.ts";
import { buildRawMarkdown } from "../src/ai/markdown.ts";
import {
  applyAgentVisibility,
  applyAudienceVisibility,
} from "../src/ai/visibility.ts";
import {
  askEndpointTemplate,
  runtimeDependencies,
} from "../src/astro/templates.ts";
import { buildContentGraph } from "../src/core/graph.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema, pageMetaSchema } from "../src/core/schema.ts";
import type { AskAiConfig } from "../src/core/schema.ts";
import type { PageRecord, RouteManifestEntry } from "../src/core/types.ts";

/** Parse an `ai.ask` block through the full schema so defaults are applied. */
const askConfig = (ask: Record<string, unknown>): AskAiConfig =>
  blumeConfigSchema.parse({ ai: { ask } }).ai.ask as AskAiConfig;

/** The runtime deps declared for a given `ai.ask` block (or default config). */
const runtimeDeps = (ask?: Record<string, unknown>): string[] =>
  runtimeDependencies({
    config: blumeConfigSchema.parse(ask ? { ai: { ask } } : {}),
    needsReact: false,
  });

let root: string;
const sources = new Map<string, string>();

const makePage = (
  id: string,
  route: string,
  title: string,
  over: Partial<PageRecord> = {}
): PageRecord => ({
  contentType: "doc",
  format: "md",
  groups: [],
  headings: [],
  id,
  links: [],
  locale: "",
  meta: pageMetaSchema.parse({}),
  navPath: id,
  route,
  segments: [],
  source: { name: "filesystem", ref: id },
  sourcePath: join(root, id),
  title,
  translationKey: route,
  ...over,
});

const makeProject = (
  pages: PageRecord[],
  config: Record<string, unknown> = {}
): BlumeProject => {
  const parsed = blumeConfigSchema.parse({
    deployment: { site: "https://example.com/" },
    description: "Desc",
    title: "Docs",
    ...config,
  });
  return {
    config: parsed,
    graph: buildContentGraph(pages, {
      folderMeta: new Map(),
      i18n: parsed.i18n,
      navigation: parsed.navigation,
    }),
    manifest: {
      routes: pages.map((page) => ({
        path: page.route,
        sourcePath: page.sourcePath,
      })),
    },
  } as unknown as BlumeProject;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-ai-"));
  const files: Record<string, string> = {
    "a.md": "---\ntitle: Alpha\n---\n# Alpha\n\nBody A.\n",
    "b.md": "---\ntitle: Beta\n---\n# Beta\n\nBody B.\n",
    "c.md": "---\ntitle: Gamma\n---\n# Gamma\n\nDraft body.\n",
    "f.md":
      '---\ntitle: Lifecycle\nstatus: retracted\n---\n# F\n\n<Callout type="warning" title={frontmatter.status}>Withdrawn.</Callout>\n',
    "t.md":
      '---\ntitle: Table\n---\n# Table\n\n<Callout type="warning">Mind the gap.</Callout>\n',
    "v.md": [
      "---",
      "title: Vis",
      "---",
      "# Vis",
      "",
      '<Visibility for="web">',
      "Web-only body.",
      "</Visibility>",
      "",
      '<Visibility for="agents">',
      "Agent-only body.",
      "</Visibility>",
      "",
      "```astro",
      '<Visibility for="web">Sample markup.</Visibility>',
      "```",
      "",
    ].join("\n"),
  };
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      sources.set(rel, content);
      await writeFile(join(root, rel), content);
    })
  );
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

const project = (): BlumeProject =>
  makeProject([
    makePage("b.md", "/b", "Beta"),
    makePage("a.md", "/a", "Alpha", { description: "First" }),
    makePage("c.md", "/c", "Gamma", {
      meta: pageMetaSchema.parse({ draft: true }),
    }),
  ]);

describe("buildLlmsFiles — index", () => {
  it("lists non-draft pages under a Docs section with absolute links", async () => {
    const { index } = await buildLlmsFiles(project());
    expect(index).toContain("# Docs");
    expect(index).toContain("> Desc");
    expect(index).toContain("## Docs");
    const links = index.split("\n").filter((line) => line.startsWith("- ["));
    expect(links).toStrictEqual([
      "- [Alpha](https://example.com/a): First",
      "- [Beta](https://example.com/b)",
    ]);
    expect(index).not.toContain("Gamma");
  });
});

describe("buildLlmsFiles — RSS feeds", () => {
  it("links the RSS feed for each content type that has pages", async () => {
    const { index } = await buildLlmsFiles(
      makeProject([
        makePage("a.md", "/blog/post", "Post", { contentType: "blog" }),
        makePage("b.md", "/b", "Beta"),
      ])
    );
    expect(index).toContain("## RSS Feeds");
    expect(index).toContain(
      "- [Docs — Blog](https://example.com/blog/rss.xml)"
    );
    // Changelog is a default RSS type but has no pages here, so no feed.
    expect(index).not.toContain("/changelog/rss.xml");
  });

  it("layers deployment.base onto the feed link", async () => {
    const { index } = await buildLlmsFiles(
      makeProject(
        [makePage("a.md", "/blog/post", "Post", { contentType: "blog" })],
        { deployment: { base: "/docs", site: "https://example.com/" } }
      )
    );
    expect(index).toContain(
      "- [Docs — Blog](https://example.com/docs/blog/rss.xml)"
    );
  });

  it("omits the feeds section when RSS is disabled", async () => {
    const { index } = await buildLlmsFiles(
      makeProject(
        [makePage("a.md", "/blog/post", "Post", { contentType: "blog" })],
        { seo: { rss: { enabled: false } } }
      )
    );
    expect(index).not.toContain("## RSS Feeds");
  });

  it("omits the feeds section without a deployment site", async () => {
    const { index } = await buildLlmsFiles(
      makeProject(
        [makePage("a.md", "/blog/post", "Post", { contentType: "blog" })],
        { deployment: {} }
      )
    );
    expect(index).not.toContain("## RSS Feeds");
  });
});

describe("buildLlmsFiles — navigation structure", () => {
  it("mirrors the sidebar tree: folders become nested headings", async () => {
    const { index } = await buildLlmsFiles(
      makeProject([
        makePage("index.md", "/", "Home", {
          body: { format: "md", text: "Home body." },
        }),
        makePage("guides/install.md", "/guides/install", "Install", {
          body: { format: "md", text: "Install body." },
          navPath: "guides/install.md",
        }),
        makePage(
          "guides/advanced/tuning.md",
          "/guides/advanced/tuning",
          "Tuning",
          {
            body: { format: "md", text: "Tuning body." },
            navPath: "guides/advanced/tuning.md",
          }
        ),
      ])
    );
    // Root loose pages get a Docs section; each folder is a heading whose
    // depth follows its nesting.
    expect(index).toContain("## Docs\n\n- [Home](https://example.com/)");
    expect(index).toContain(
      "## Guides\n\n- [Install](https://example.com/guides/install)"
    );
    expect(index).toContain(
      "### Advanced\n\n- [Tuning](https://example.com/guides/advanced/tuning)"
    );
  });

  it("appends pages an explicit sidebar omits under Other, route-sorted", async () => {
    const { index } = await buildLlmsFiles(
      makeProject(
        [
          makePage("a.md", "/a", "Alpha", { description: "First" }),
          makePage("c.md", "/c", "Gamma"),
          makePage("b.md", "/b", "Beta"),
        ],
        { navigation: { sidebar: ["a"] } }
      )
    );
    expect(index).toContain("## Docs\n\n- [Alpha](https://example.com/a)");
    expect(index).toContain(
      "## Other\n\n- [Beta](https://example.com/b)\n- [Gamma](https://example.com/c)"
    );
  });

  it("labels non-default locale trees with the locale under i18n", async () => {
    const { index } = await buildLlmsFiles(
      makeProject(
        [
          makePage("a.md", "/a", "Alpha", { locale: "en" }),
          makePage("a.md", "/fr/a", "Alpha FR", {
            locale: "fr",
            navPath: "a.md",
          }),
        ],
        {
          i18n: {
            defaultLocale: "en",
            locales: [
              { code: "en", label: "English" },
              { code: "fr", label: "Français" },
            ],
          },
        }
      )
    );
    // The default locale renders unlabeled; other locales get a section whose
    // own groups start one level deeper.
    expect(index).toContain("## Docs\n\n- [Alpha](https://example.com/a)");
    expect(index).toContain(
      "## Français\n\n### Docs\n\n- [Alpha FR](https://example.com/fr/a)"
    );
  });

  it("falls back to a flat Docs list when locale trees are missing", async () => {
    const proj = makeProject(
      [makePage("a.md", "/a", "Alpha", { locale: "en" })],
      {
        i18n: {
          defaultLocale: "en",
          locales: [
            { code: "en", label: "English" },
            { code: "fr", label: "Français" },
          ],
        },
      }
    );
    proj.graph.navigationByLocale = {};
    const { index } = await buildLlmsFiles(proj);
    // Every page lands in the leftover pass, which titles itself "Docs" when
    // nothing else was emitted.
    expect(index).toContain("## Docs\n\n- [Alpha](https://example.com/a)");
    expect(index).not.toContain("## Other");
  });
});

describe("buildLlmsFiles — ai.llmsTxt.openapi", () => {
  const apiPage = (): PageRecord =>
    makePage("openapi:reference/get-pet.mdx", "/reference/get-pet", "Get Pet", {
      body: { format: "mdx", text: "API operation body." },
      navPath: "reference/get-pet.mdx",
      source: { name: "openapi", ref: "reference/get-pet.mdx" },
    });

  it("includes generated API reference pages by default", async () => {
    const { full, index } = await buildLlmsFiles(
      makeProject([makePage("a.md", "/a", "Alpha"), apiPage()])
    );
    expect(index).toContain("## Reference");
    expect(index).toContain(
      "- [Get Pet](https://example.com/reference/get-pet)"
    );
    expect(full).toContain("API operation body.");
  });

  it("drops them from both files when openapi is false", async () => {
    const { full, index } = await buildLlmsFiles(
      makeProject([makePage("a.md", "/a", "Alpha"), apiPage()], {
        ai: { llmsTxt: { openapi: false } },
      })
    );
    expect(index).toContain("- [Alpha]");
    expect(index).not.toContain("Get Pet");
    // The section left empty by the exclusion emits no heading at all.
    expect(index).not.toContain("## Reference");
    expect(full).toContain("Body A.");
    expect(full).not.toContain("API operation body.");
  });
});

describe("ai.llmsTxt schema", () => {
  it("resolves the boolean shorthand and the object form", () => {
    expect(blumeConfigSchema.parse({}).ai.llmsTxt).toStrictEqual({
      enabled: true,
      openapi: true,
    });
    expect(
      blumeConfigSchema.parse({ ai: { llmsTxt: false } }).ai.llmsTxt
    ).toStrictEqual({ enabled: false, openapi: true });
    expect(
      blumeConfigSchema.parse({ ai: { llmsTxt: { openapi: false } } }).ai
        .llmsTxt
    ).toStrictEqual({ enabled: true, openapi: false });
  });
});

describe("buildLlmsFiles — full", () => {
  it("emits each page body with its source URL, excluding drafts", async () => {
    const { full } = await buildLlmsFiles(project());
    expect(full).toContain("Source: https://example.com/a");
    expect(full).toContain("Body A.");
    expect(full).toContain("Body B.");
    // The section separator joins page bodies.
    expect(full).toContain("\n---\n");
    expect(full).not.toContain("Draft body.");
  });
});

describe("buildLlmsFiles — visibility and encoding", () => {
  it("excludes hidden and noindex pages, matching the sitemap", async () => {
    const { full, index } = await buildLlmsFiles(
      makeProject([
        makePage("a.md", "/a", "Alpha"),
        makePage("b.md", "/b", "Beta", {
          meta: pageMetaSchema.parse({ sidebar: { hidden: true } }),
        }),
        makePage("c.md", "/c", "Gamma", {
          meta: pageMetaSchema.parse({ seo: { noindex: true } }),
        }),
      ])
    );
    expect(index).toContain("- [Alpha]");
    expect(index).not.toContain("Beta");
    expect(index).not.toContain("Gamma");
    expect(full).toContain("Body A.");
    expect(full).not.toContain("Body B.");
    expect(full).not.toContain("Draft body.");
  });

  it("percent-encodes page URLs, matching the sitemap", async () => {
    const { full, index } = await buildLlmsFiles(
      makeProject([makePage("a.md", "/tips & tricks", "Tips")])
    );
    expect(index).toContain("(https://example.com/tips%20&%20tricks)");
    expect(full).toContain("Source: https://example.com/tips%20&%20tricks");
  });
});

const sitelessProject = (config: Record<string, unknown> = {}): BlumeProject =>
  makeProject([makePage("a.md", "/a", "Alpha", { description: "First" })], {
    deployment: {},
    description: undefined,
    title: "Docs",
    ...config,
  });

describe("buildLlmsFiles — without a deployment site", () => {
  it("emits root-relative links when no site is configured", async () => {
    const { full, index } = await buildLlmsFiles(sitelessProject());
    expect(index).toContain("- [Alpha](/a): First");
    expect(full).toContain("Source: /a");
    expect(index).not.toContain("https://");
  });

  it("layers deployment.base onto root-relative links", async () => {
    // Pages are still served under the base subpath without a site, so a bare
    // `/a` link would 404 (the sitemap/mcp.json convention).
    const { full, index } = await buildLlmsFiles(
      sitelessProject({ deployment: { base: "/docs" } })
    );
    expect(index).toContain("- [Alpha](/docs/a): First");
    expect(full).toContain("Source: /docs/a");
  });
});

describe("buildRawMarkdown", () => {
  it("maps every route to its raw (frontmatter-included) source", async () => {
    const raw = await buildRawMarkdown(project());
    expect(raw["/a"]?.mdx).toBe(sources.get("a.md") ?? "");
    expect(raw["/b"]?.mdx).toBe(sources.get("b.md") ?? "");
    expect(raw["/a"]?.mdx).toContain("title: Alpha");
    // Component-free pages don't store a second (identical) md variant.
    expect(raw["/a"]?.md).toBeUndefined();
  });
});

describe("component downleveling in agent surfaces", () => {
  const tableProject = (): BlumeProject =>
    makeProject([makePage("t.md", "/t", "Table")]);

  it("stores a downleveled md variant beside the verbatim source", async () => {
    const raw = await buildRawMarkdown(tableProject());
    expect(raw["/t"]?.mdx).toContain('<Callout type="warning">');
    expect(raw["/t"]?.md).toContain("> **Warning**\n>\n> Mind the gap.");
    expect(raw["/t"]?.md).not.toContain("<Callout");
  });

  it("downlevels components in llms-full.txt", async () => {
    const { full } = await buildLlmsFiles(tableProject());
    expect(full).toContain("> **Warning**\n>\n> Mind the gap.");
    expect(full).not.toContain("<Callout");
  });

  it("honors ai.markdownComponents serializers from the config", async () => {
    const customized = tableProject();
    customized.config = blumeConfigSchema.parse({
      ai: {
        markdownComponents: {
          Callout: ({ children }: { children: string }) => `NOTE: ${children}`,
        },
      },
    }) as BlumeProject["config"];
    const raw = await buildRawMarkdown(customized);
    expect(raw["/t"]?.md).toContain("NOTE: Mind the gap.");
    const { full } = await buildLlmsFiles(customized);
    expect(full).toContain("NOTE: Mind the gap.");
  });

  it("evaluates {frontmatter.*} props against the page front-matter", async () => {
    // The single-source-of-truth pattern from #93: a prop bound to a
    // front-matter key must survive downleveling on both agent surfaces.
    const fmProject = makeProject([makePage("f.md", "/f", "Lifecycle")]);
    const raw = await buildRawMarkdown(fmProject);
    expect(raw["/f"]?.md).toContain("> **retracted**\n>\n> Withdrawn.");
    expect(raw["/f"]?.md).not.toContain("<Callout");
    const { full } = await buildLlmsFiles(fmProject);
    expect(full).toContain("> **retracted**\n>\n> Withdrawn.");
  });

  it("validates markdownComponents entries are functions", () => {
    expect(
      blumeConfigSchema.safeParse({
        ai: { markdownComponents: { Chart: "not a function" } },
      }).success
    ).toBe(false);
    const parsed = blumeConfigSchema.parse({});
    expect(parsed.ai.markdownComponents).toStrictEqual({});
  });
});

describe("agent-facing markdown honors <Visibility>", () => {
  const visProject = (): BlumeProject =>
    makeProject([makePage("v.md", "/v", "Vis")]);

  it("filters llms-full.txt: web removed, agents unwrapped, fences kept", async () => {
    const { full } = await buildLlmsFiles(visProject());
    expect(full).not.toContain("Web-only body.");
    expect(full).toContain("Agent-only body.");
    expect(full).not.toContain('<Visibility for="agents">');
    // The fenced code sample documenting the tag survives verbatim.
    expect(full).toContain('<Visibility for="web">Sample markup.</Visibility>');
  });

  it("filters the raw .md mirrors while keeping frontmatter", async () => {
    const raw = await buildRawMarkdown(visProject());
    const source = raw["/v"]?.mdx ?? "";
    expect(source).toContain("title: Vis");
    expect(source).not.toContain("Web-only body.");
    expect(source).toContain("Agent-only body.");
    expect(source).not.toContain('<Visibility for="agents">');
    expect(source).toContain(
      '<Visibility for="web">Sample markup.</Visibility>'
    );
  });
});

describe("applyAgentVisibility", () => {
  it("removes web blocks, unwraps agents blocks, and collapses the gaps", () => {
    const input = [
      "Intro.",
      "",
      '<Visibility for="web">',
      "Web-only note.",
      "</Visibility>",
      "",
      '<Visibility for="agents">',
      "Agent-only note.",
      "</Visibility>",
      "",
      "Outro.",
    ].join("\n");
    expect(applyAgentVisibility(input)).toBe(
      "Intro.\n\nAgent-only note.\n\nOutro."
    );
  });

  it("accepts single quotes and whitespace around the attribute", () => {
    const input =
      "A <Visibility  for = 'web' >gone</Visibility > B " +
      "<Visibility for='agents'>kept</Visibility> C";
    const out = applyAgentVisibility(input);
    expect(out).not.toContain("gone");
    expect(out).toContain("kept");
    expect(out).not.toContain("<Visibility");
  });

  it("returns markdown without Visibility blocks byte-identical", () => {
    // Includes a run of blank lines: the tidy pass must not fire when nothing
    // matched, so raw sources stay raw.
    const input = "# Title\n\n\n\nBody with `<code>`.\n";
    expect(applyAgentVisibility(input)).toBe(input);
  });

  it("leaves other audiences (the component default) untouched", () => {
    const input = '<Visibility for="humans">On the web.</Visibility>\n';
    expect(applyAgentVisibility(input)).toBe(input);
  });

  it("leaves fenced samples untouched, including tilde fences", () => {
    const input = [
      "~~~astro",
      '<Visibility for="web">shown in the sample</Visibility>',
      "~~~",
      "",
      '<Visibility for="web">really gone</Visibility>',
      "",
    ].join("\n");
    const out = applyAgentVisibility(input);
    expect(out).toContain("shown in the sample");
    expect(out).not.toContain("really gone");
  });

  it("degrades safely on nested blocks (unsupported)", () => {
    // Non-greedy matching closes the outer block at the FIRST end tag, so a
    // nested block truncates the removal early and the remainder passes
    // through verbatim. Nesting is not supported — this only pins down that
    // the degradation is inert rather than destructive.
    const input =
      '<Visibility for="web">A ' +
      '<Visibility for="agents">B</Visibility> C</Visibility>';
    expect(applyAgentVisibility(input)).toBe(" C</Visibility>");
  });

  it("resolves the web audience symmetrically: agents dropped, web unwrapped", () => {
    const input = [
      "Intro.",
      "",
      '<Visibility for="web">',
      "Web-only note.",
      "</Visibility>",
      "",
      "<Visibility for='agents'>",
      "Agent-only note.",
      "</Visibility>",
      "",
      "Outro.",
    ].join("\n");
    expect(applyAudienceVisibility(input, "web")).toBe(
      "Intro.\n\nWeb-only note.\n\nOutro."
    );
  });

  it("web audience also round-trips untouched markdown byte-identical", () => {
    const input = "# Title\n\n\n\nBody.\n";
    expect(applyAudienceVisibility(input, "web")).toBe(input);
  });

  it("restores an unrecognized fence token verbatim", () => {
    // A NUL-delimited token cannot appear in authored markdown; if one does,
    // it must round-trip untouched rather than crash the unmask pass.
    const weird = "before \u0000blume-fence-9\u0000 after";
    expect(applyAgentVisibility(weird)).toBe(weird);
  });
});

/** A route manifest entry backed by one of the temp fixture files. */
const askRoute = (over: Partial<RouteManifestEntry>): RouteManifestEntry =>
  ({
    contentType: "doc",
    draft: false,
    hidden: false,
    id: "a.md",
    indexable: true,
    locale: "",
    path: "/a",
    sourcePath: join(root, "a.md"),
    title: "Alpha",
    ...over,
  }) as RouteManifestEntry;

const askDataProject = (): BlumeProject =>
  ({
    config: blumeConfigSchema.parse({
      deployment: { site: "https://example.com/" },
      title: "Docs",
    }),
    graph: {
      pages: [
        makePage("a.md", "/a", "Alpha", { description: "First" }),
        makePage("b.md", "/b", "Beta"),
      ],
    },
    manifest: {
      routes: [
        askRoute({ id: "a.md", path: "/a", title: "Alpha" }),
        askRoute({ id: "b.md", path: "/b", title: "Beta" }),
      ],
    },
  }) as unknown as BlumeProject;

describe("buildAskData", () => {
  it("indexes page bodies with locale and the deployment site", async () => {
    const data = await buildAskData(askDataProject());
    expect(data.site).toBe("https://example.com/");
    const alpha = data.documents.find((doc) => doc.route === "/a");
    expect(alpha?.title).toBe("Alpha");
    expect(alpha?.content).toContain("Body A.");
    expect(alpha).toHaveProperty("locale", "");
  });

  it("resolves <Visibility> for the agents audience", async () => {
    const proj = {
      config: blumeConfigSchema.parse({ title: "Docs" }),
      graph: { pages: [makePage("v.md", "/v", "Vis")] },
      manifest: {
        routes: [
          askRoute({
            id: "v.md",
            path: "/v",
            sourcePath: join(root, "v.md"),
            title: "Vis",
          }),
        ],
      },
    } as unknown as BlumeProject;
    const data = await buildAskData(proj);
    const doc = data.documents.find((entry) => entry.route === "/v");
    expect(doc?.content).toContain("Agent-only body.");
    expect(doc?.content).not.toContain("Web-only body.");
    // Grounding keeps Markdown, so the fenced sample survives verbatim.
    expect(doc?.content).toContain(
      '<Visibility for="web">Sample markup.</Visibility>'
    );
  });
});

const askData: AskData = {
  documents: [
    {
      content:
        "Install Blume with your package manager, then run the dev server to preview the docs.",
      description: "How to install Blume",
      locale: "",
      route: "/guides/install",
      title: "Installation",
    },
    {
      content:
        "Configure themes, navigation, and search in blume.config.ts to customize the site.",
      description: "Configuration reference",
      locale: "",
      route: "/guides/config",
      title: "Configuration",
    },
  ],
  site: "https://example.com",
};

describe("createAskContext", () => {
  it("grounds the prompt in the retrieved page and asks the model to cite", async () => {
    const ground = createAskContext(askData);
    const system = await ground([
      { content: "how do I install the dev server", role: "user" },
    ]);
    expect(system).toContain("<docs>");
    expect(system).toContain("Installation (/guides/install)");
    expect(system).toContain("run the dev server");
    expect(system).toContain("Markdown link");
    expect(system).toContain("[Page Title](/route)");
  });

  it("returns undefined when there is no user message to ground on", async () => {
    const ground = createAskContext(askData);
    expect(await ground([])).toBeUndefined();
    expect(
      await ground([{ content: "hello", role: "assistant" }])
    ).toBeUndefined();
  });

  it("injects the current page as priority context", async () => {
    const ground = createAskContext(askData);
    const system = await ground([{ content: "themes", role: "user" }], {
      path: "/guides/install/",
    });
    expect(system).toContain("the page the user is currently viewing");
    expect(system).toContain("Installation (/guides/install)");
  });

  it("filters retrieval to the current page's locale", async () => {
    const ground = createAskContext({
      documents: [
        {
          content: "installation guide in english",
          description: "",
          locale: "en",
          route: "/en/install",
          title: "Install EN",
        },
        {
          content: "installation guide in french",
          description: "",
          locale: "fr",
          route: "/fr/install",
          title: "Install FR",
        },
      ],
      site: null,
    });
    const system = await ground([{ content: "installation", role: "user" }], {
      path: "/fr/install",
    });
    expect(system).toContain("Install FR");
    expect(system).not.toContain("Install EN");
  });

  it("truncates long excerpts and returns undefined for an empty corpus", async () => {
    const long = "word ".repeat(1000);
    const grounded = createAskContext({
      documents: [
        {
          content: long,
          description: "",
          locale: "",
          route: "/big",
          title: "Big",
        },
      ],
      site: null,
    });
    const system = await grounded([{ content: "word", role: "user" }]);
    expect(system).toContain("…");
    expect((system ?? "").length).toBeLessThan(long.length);

    const empty = createAskContext({ documents: [], site: null });
    expect(
      await empty([{ content: "anything", role: "user" }])
    ).toBeUndefined();
  });

  it("centers the excerpt on the query-relevant section of a long page", async () => {
    // A long page whose answer sits well past the excerpt cap: the head is
    // ~3.6k chars, so a naive head slice would never reach `targetword`.
    const head = `STARTMARKER ${"alpha ".repeat(600)}`;
    const deep = "The targetword feature is documented far below the fold. ";
    const grounded = createAskContext({
      documents: [
        {
          content: `${head}${deep}${"tail ".repeat(200)}`,
          description: "",
          locale: "",
          route: "/long",
          title: "Long",
        },
      ],
      site: null,
    });
    const system = await grounded([
      { content: "how does targetword work", role: "user" },
    ]);
    // The relevant section is injected even though it's below the fold…
    expect(system).toContain("targetword feature");
    // …and the skipped head (its opening marker) never reaches the prompt.
    expect(system).not.toContain("STARTMARKER");
    expect(system).toContain("…");
  });

  it("falls back to the page head when the query misses a long page", async () => {
    const head = `HEADMARKER ${"alpha ".repeat(600)}`;
    const grounded = createAskContext({
      documents: [
        { content: head, description: "", locale: "", route: "/p", title: "P" },
      ],
      site: null,
    });
    // The query terms don't appear in the body, but the current page is always
    // injected — with no match to center on, it excerpts from the head.
    const system = await grounded(
      [{ content: "unrelated xyz", role: "user" }],
      {
        path: "/p",
      }
    );
    expect(system).toContain("HEADMARKER");
  });
});

describe("relevantExcerpt", () => {
  it("keeps the match in view when the window is narrower than the lead-in", () => {
    // A remaining context budget under EXCERPT_LEAD (160) shrinks the window
    // below the lead-in; the uncapped `best - 160` start used to end the slice
    // before the match, injecting an irrelevant lead-in snippet.
    const content = `${"alpha ".repeat(120)}targetword closes the section. ${"tail ".repeat(60)}`;
    const excerpt = relevantExcerpt(content, "targetword", 100);
    expect(excerpt).toContain("targetword");
    // At most the window plus the two ellipsis characters.
    expect(excerpt.length).toBeLessThanOrEqual(102);
  });

  it("keeps the full lead-in when the window affords it", () => {
    const content = `${"alpha ".repeat(120)}targetword closes the section. ${"tail ".repeat(60)}`;
    const excerpt = relevantExcerpt(content, "targetword", 600);
    // The 160-char lead-in of heading/sentence context survives intact.
    expect(excerpt).toContain(`${"alpha ".repeat(26)}targetword`);
  });
});

describe("resolveAskBackend", () => {
  it("defaults to the gateway backend when ask is unset", () => {
    expect(resolveAskBackend()).toStrictEqual({
      kind: "gateway",
      model: "openai/gpt-5.5",
    });
  });

  it("uses the dedicated provider and preset env var for openrouter", () => {
    const backend = resolveAskBackend(
      askConfig({ enabled: true, model: "anthropic/x", provider: "openrouter" })
    );
    expect(backend).toStrictEqual({
      apiKeyEnv: "OPENROUTER_API_KEY",
      kind: "openrouter",
      model: "anthropic/x",
    });
  });

  it("maps the OpenAI-compatible providers to their presets", () => {
    expect(
      resolveAskBackend(askConfig({ provider: "llmgateway" }))
    ).toMatchObject({
      apiKeyEnv: "LLMGATEWAY_API_KEY",
      baseUrl: "https://api.llmgateway.io/v1",
      kind: "openai-compatible",
      name: "llmgateway",
    });
    expect(resolveAskBackend(askConfig({ provider: "inkeep" }))).toMatchObject({
      apiKeyEnv: "INKEEP_API_KEY",
      baseUrl: "https://api.inkeep.com/v1",
      kind: "openai-compatible",
      name: "inkeep",
    });
  });

  it("honors baseUrl and apiKeyEnv overrides", () => {
    expect(
      resolveAskBackend(
        askConfig({
          apiKeyEnv: "MY_KEY",
          baseUrl: "https://proxy.example/v1",
          provider: "llmgateway",
        })
      )
    ).toMatchObject({
      apiKeyEnv: "MY_KEY",
      baseUrl: "https://proxy.example/v1",
    });
  });

  it("carries the user baseUrl through for openai-compatible", () => {
    expect(
      resolveAskBackend(
        askConfig({
          apiKeyEnv: "GW_KEY",
          baseUrl: "https://gw.example/v1",
          provider: "openai-compatible",
        })
      )
    ).toStrictEqual({
      apiKeyEnv: "GW_KEY",
      baseUrl: "https://gw.example/v1",
      kind: "openai-compatible",
      model: "openai/gpt-5.5",
      name: "openai-compatible",
    });
  });
});

describe("ai.ask schema", () => {
  it("requires baseUrl for the openai-compatible provider", () => {
    expect(() =>
      blumeConfigSchema.parse({
        ai: { ask: { enabled: true, provider: "openai-compatible" } },
      })
    ).toThrow(/ai\.ask\.baseUrl is required/u);
  });

  it("accepts openai-compatible with a baseUrl", () => {
    expect(() =>
      blumeConfigSchema.parse({
        ai: {
          ask: {
            baseUrl: "https://gw.example/v1",
            enabled: true,
            provider: "openai-compatible",
          },
        },
      })
    ).not.toThrow();
  });
});

describe("askEndpointTemplate", () => {
  it("grounds the gateway endpoint and imports the retrieval helper", () => {
    const out = askEndpointTemplate(resolveAskBackend(), true);
    expect(out).toContain('import { streamText } from "ai";');
    expect(out).not.toContain("@openrouter/ai-sdk-provider");
    expect(out).not.toContain("@ai-sdk/openai-compatible");
    expect(out).toContain('model: "openai/gpt-5.5"');
    expect(out).toContain(
      'import { createAskContext } from "blume/ai/ask-context.ts";'
    );
    // The endpoint lives at `src/pages/api/ask.ts`; the data at
    // `src/generated/ask-data.json` — so the import must climb two levels.
    expect(out).toContain(
      'import askData from "../../generated/ask-data.json";'
    );
    expect(out).toContain("const ground = createAskContext(askData);");
    expect(out).toContain("await ground(messages, body.page)");
    // Hardened: validates the body, caps it, and handles stream errors.
    expect(out).toContain("await request.json().catch(() => null)");
    expect(out).toContain("Array.isArray(raw)");
    // Only user/assistant roles pass — a caller can't inject a system prompt
    // and repurpose the endpoint as an open LLM proxy.
    expect(out).toContain('m.role === "user" || m.role === "assistant"');
    expect(out).toContain('typeof m.content === "string"');
    expect(out).toContain("status: 400");
    expect(out).toContain("status: 500");
  });

  it("rejects a missing gateway credential up front and logs stream errors", () => {
    const out = askEndpointTemplate(resolveAskBackend(), true);
    // streamText defers provider/auth errors to stream consumption, so the
    // handler's try/catch never sees a missing key: the guard must run before
    // streamText or the client gets a 200 whose stream aborts mid-flight.
    expect(out).toContain(
      "if (!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN))"
    );
    expect(out).toContain("Ask AI is not configured: set AI_GATEWAY_API_KEY");
    expect(out.indexOf("Ask AI is not configured")).toBeLessThan(
      out.indexOf("streamText({")
    );
    // Mid-stream provider errors are only observable via onError.
    expect(out).toContain("onError({ error })");
    expect(out).toContain('console.error("Ask AI provider error:", error);');
  });

  it("guards the provider key env var for non-gateway backends", () => {
    const openrouter = askEndpointTemplate(
      resolveAskBackend(askConfig({ provider: "openrouter" })),
      true
    );
    expect(openrouter).toContain('if (!process.env["OPENROUTER_API_KEY"])');
    expect(openrouter).toContain(
      "Ask AI is not configured: set OPENROUTER_API_KEY."
    );
    expect(openrouter).not.toContain("AI_GATEWAY_API_KEY");

    // The ungrounded branch builds its streamText call separately; it must
    // carry the same onError logging.
    const inkeep = askEndpointTemplate(
      resolveAskBackend(askConfig({ provider: "inkeep" })),
      false
    );
    expect(inkeep).toContain('if (!process.env["INKEEP_API_KEY"])');
    expect(inkeep).toContain("onError({ error })");
  });

  it("leaves the Inkeep endpoint ungrounded (it runs its own retrieval)", () => {
    const out = askEndpointTemplate(
      resolveAskBackend(askConfig({ provider: "inkeep" })),
      false
    );
    expect(out).toContain(
      'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";'
    );
    expect(out).not.toContain("createAskContext");
    expect(out).not.toContain("ask-data.json");
    expect(out).toContain("await request.json().catch(() => null)");
    expect(out).toContain("Answer using the project's documentation.");
  });

  it("wires the OpenRouter provider and its env var", () => {
    const out = askEndpointTemplate(
      resolveAskBackend(
        askConfig({ model: "anthropic/x", provider: "openrouter" })
      ),
      true
    );
    expect(out).toContain(
      'import { createOpenRouter } from "@openrouter/ai-sdk-provider";'
    );
    expect(out).toContain('process.env["OPENROUTER_API_KEY"]');
    expect(out).toContain('model: openrouter("anthropic/x")');
  });

  it("wires the OpenAI-compatible provider with the preset base URL", () => {
    const out = askEndpointTemplate(
      resolveAskBackend(askConfig({ provider: "llmgateway" })),
      true
    );
    expect(out).toContain(
      'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";'
    );
    expect(out).toContain('baseURL: "https://api.llmgateway.io/v1"');
    expect(out).toContain('process.env["LLMGATEWAY_API_KEY"]');
  });
});

describe("ask backend runtime dependency", () => {
  it("adds no provider dep for the gateway backend", () => {
    expect(askBackendRuntimeDep()).toBeUndefined();
    expect(runtimeDeps({ enabled: true })).not.toContain(
      "@ai-sdk/openai-compatible"
    );
  });

  it("declares the dedicated SDK only when its backend is enabled", () => {
    expect(runtimeDeps({ enabled: true, provider: "openrouter" })).toContain(
      "@openrouter/ai-sdk-provider"
    );
    expect(
      runtimeDeps({
        baseUrl: "https://x/v1",
        enabled: true,
        provider: "openai-compatible",
      })
    ).toContain("@ai-sdk/openai-compatible");
  });

  it("declares nothing when Ask AI is disabled", () => {
    expect(
      runtimeDeps({ enabled: false, provider: "openrouter" })
    ).not.toContain("@openrouter/ai-sdk-provider");
  });
});

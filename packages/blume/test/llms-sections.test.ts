import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import type { BuiltAgentPage } from "../src/ai/built-pages.ts";
import { buildLlmsFiles, buildLlmsIndex } from "../src/ai/llms.ts";
import { buildContentGraph } from "../src/core/graph.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema, pageMetaSchema } from "../src/core/schema.ts";
import type { BlumeConfigInput } from "../src/core/schema.ts";
import type {
  BlumeManifest,
  PageRecord,
  ProjectContext,
  RouteManifestEntry,
} from "../src/core/types.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-llms-sections-"));
  const files = [
    "index.md",
    "guides/install.md",
    "guides/advanced/tuning.md",
    "api/get.md",
    "changelog/v1.md",
  ];
  await Promise.all(
    files.map(async (file) => {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), `# ${file}\n\nBody of ${file}.\n`);
    })
  );
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

const makePage = (id: string, route: string, title: string): PageRecord => ({
  anchors: [],
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
  version: "",
  versionKey: route,
});

const makeProject = (
  pages: PageRecord[],
  config: BlumeConfigInput = {}
): BlumeProject => {
  const parsed = blumeConfigSchema.parse({
    deployment: { site: "https://example.com/" },
    description: "Desc",
    title: "Docs",
    ...config,
  });
  const routes: Partial<RouteManifestEntry>[] = pages.map((page) => ({
    path: page.route,
    sourcePath: page.sourcePath,
  }));
  const project: Partial<BlumeProject> = {
    config: parsed,
    // SAFETY: the llms builders read only `root` from the context.
    context: { root } as ProjectContext,
    graph: buildContentGraph(pages, {
      folderMeta: new Map(),
      i18n: parsed.i18n,
      navigation: parsed.navigation,
    }),
    // SAFETY: the llms builders read only each route's path and sourcePath.
    manifest: { routes } as BlumeManifest,
    sources: [],
  };
  // SAFETY: the llms builders touch only config, context, graph, manifest,
  // and sources.
  return project as BlumeProject;
};

const docsPages = (): PageRecord[] => [
  makePage("index.md", "/", "Home"),
  makePage("guides/install.md", "/guides/install", "Install"),
  makePage("guides/advanced/tuning.md", "/guides/advanced/tuning", "Tuning"),
  makePage("api/get.md", "/api/get", "Get"),
  makePage("changelog/v1.md", "/changelog/v1", "v1"),
];

const custom = (
  route: string,
  title: string,
  description?: string
): BuiltAgentPage => {
  const page: BuiltAgentPage = {
    document: { markdown: `# ${title}\n\nAbout ${route}.`, title },
    noindex: false,
    route,
  };
  if (description !== undefined) {
    page.document.description = description;
  }
  return page;
};

/** Where each heading sits in the index, so tests can compare their order. */
const at = (index: string, text: string): number => {
  const position = index.indexOf(text);
  expect(position).toBeGreaterThan(-1);
  return position;
};

describe("llms.txt section order", () => {
  it("orders the sidebar's sections by the header's tabs", () => {
    const index = buildLlmsIndex(
      makeProject(docsPages(), {
        navigation: {
          tabs: [
            { label: "Guides", path: "/guides" },
            { label: "API", path: "/api" },
          ],
        },
      })
    );
    // Without tabs the groups sort by name (API, Changelog, Guides); the tabs
    // put Guides and API first, and the group under no tab goes last.
    expect(at(index, "## Guides")).toBeLessThan(at(index, "## API"));
    expect(at(index, "## API")).toBeLessThan(at(index, "## Changelog"));
    // Loose root pages still lead, and nested groups stay inside theirs.
    expect(at(index, "## Docs")).toBeLessThan(at(index, "## Guides"));
    expect(at(index, "### Advanced")).toBeLessThan(at(index, "## API"));
  });

  it("keeps the sidebar's own order with no tabs", () => {
    const index = buildLlmsIndex(makeProject(docsPages()));
    expect(at(index, "## API")).toBeLessThan(at(index, "## Changelog"));
    expect(at(index, "## Changelog")).toBeLessThan(at(index, "## Guides"));
  });

  it("places an explicit group by its link, its first page, or not at all", () => {
    const index = buildLlmsIndex(
      makeProject(docsPages(), {
        navigation: {
          sidebar: [
            // No folder path: placed by its first page, nested one level down.
            { items: [{ items: ["api/get"], label: "Calls" }], label: "Ref" },
            // Placed by its root link.
            { items: ["guides/install"], label: "Learn", root: "guides" },
            // Nothing to place it by: after every tab.
            { items: [], label: "Empty" },
            "changelog/v1",
          ],
          tabs: [
            { label: "Guides", path: "/guides" },
            { label: "API", path: "/api" },
          ],
        },
      })
    );
    expect(at(index, "## Learn")).toBeLessThan(at(index, "## Ref"));
    expect(at(index, "### Calls")).toBeGreaterThan(at(index, "## Ref"));
    expect(index).not.toContain("## Empty");
  });
});

describe("llms.txt custom pages", () => {
  const tabs = {
    navigation: {
      tabs: [
        { label: "Docs", path: "/" },
        { label: "Providers", path: "/providers" },
        { label: "Changelog", path: "/changelog" },
      ],
    },
  };

  it("lists custom pages under their tab, the tab's own page first", () => {
    const index = buildLlmsIndex(makeProject(docsPages(), tabs), {
      pages: [
        custom("/providers/oxlint", "Oxlint", "The fast one."),
        custom("/providers/biome", "Biome"),
        custom("/providers", "Providers", "Every engine."),
        custom("/pricing", "Pricing"),
      ],
    });
    expect(index).toContain(
      [
        "## Providers",
        "",
        "- [Providers](https://example.com/providers): Every engine.",
        "- [Biome](https://example.com/providers/biome)",
        "- [Oxlint](https://example.com/providers/oxlint): The fast one.",
      ].join("\n")
    );
    // In tab order: before the changelog, after the docs' own sections.
    expect(at(index, "## Guides")).toBeLessThan(at(index, "## Providers"));
    expect(at(index, "## Providers")).toBeLessThan(at(index, "## Changelog"));
    // A page under no section tab (only the root tab) gets the generic
    // section, after every tab's.
    expect(index).toContain(
      "## Pages\n\n- [Pricing](https://example.com/pricing)"
    );
    expect(at(index, "## Changelog")).toBeLessThan(at(index, "## Pages"));
  });

  it("keeps custom pages when no navigation tree takes them", () => {
    const project = makeProject([makePage("index.md", "/", "Home")], {
      i18n: {
        defaultLocale: "en",
        locales: [
          { code: "en", label: "English" },
          { code: "fr", label: "Français" },
        ],
      },
    });
    project.graph.navigationByLocale = {};
    const index = buildLlmsIndex(project, {
      pages: [custom("/pricing", "Pricing")],
    });
    expect(index).toContain(
      "## Pages\n\n- [Pricing](https://example.com/pricing)"
    );
  });
});

describe("llms-full.txt order", () => {
  it("follows the index, custom pages included", async () => {
    const { full } = await buildLlmsFiles(
      makeProject(docsPages(), {
        navigation: {
          tabs: [
            { label: "Guides", path: "/guides" },
            { label: "Providers", path: "/providers" },
            { label: "API", path: "/api" },
          ],
        },
      }),
      { pages: [custom("/providers/oxlint", "Oxlint")] }
    );
    // Route order would put /api/get first; the index puts the root page,
    // then the Guides tab, then Providers, then API, then the rest.
    const order = [
      "Source: https://example.com/\n",
      "Source: https://example.com/guides/install\n",
      "Source: https://example.com/guides/advanced/tuning\n",
      "Source: https://example.com/providers/oxlint\n",
      "Source: https://example.com/api/get\n",
      "Source: https://example.com/changelog/v1\n",
    ].map((source) => at(full, source));
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    // The custom page's section is its title, its URL, and its Markdown,
    // the title heading not repeated.
    expect(full).toContain(
      "# Oxlint\nSource: https://example.com/providers/oxlint\n\nAbout /providers/oxlint."
    );
  });
});

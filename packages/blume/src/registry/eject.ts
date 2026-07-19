import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { join, relative } from "pathe";

import { buildAskData } from "../ai/ask-data.ts";
import { resolveAskBackend } from "../ai/ask.ts";
import { buildRawMarkdown } from "../ai/markdown.ts";
import { buildMcpData } from "../ai/mcp/data.ts";
import { buildMcpDiscovery, buildMcpServerCard } from "../ai/mcp/discovery.ts";
import { planComponentSlots } from "../astro/component-slots.ts";
import { discoverExamples } from "../astro/examples.ts";
import {
  buildRuntimeData,
  collectStaged,
  detectNeedsReact,
  detectUsesMath,
} from "../astro/generate.ts";
import { discoverIslands } from "../astro/islands.ts";
import { customOgRoutes, discoverPages, routeIsTaken } from "../astro/pages.ts";
import {
  askEndpointTemplate,
  askComponentTemplate,
  astroConfigTemplate,
  catchAllPageTemplate,
  changelogIndexTemplate,
  contentConfigTemplate,
  envTemplate,
  exampleMapTemplate,
  exampleWrapperTemplate,
  examplesPageTemplate,
  exampleSlug,
  islandMapTemplate,
  islandWrapperTemplate,
  mcpEndpointTemplate,
  mcpPageFile,
  mixedbreadSearchEndpointTemplate,
  notFoundPageTemplate,
  ogEndpointTemplate,
  rawMarkdownEndpointTemplate,
  rssEndpointTemplate,
  runtimeTsconfigTemplate,
  searchClientTemplate,
  searchEndpointTemplate,
  staticJsonEndpointTemplate,
} from "../astro/templates.ts";
import { packageRoot } from "../core/package-root.ts";
import { scanProject } from "../core/project-graph.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { ProjectContext } from "../core/types.ts";
import { buildRssFeeds, renderRssFeed } from "../deploy/rss.ts";
import { hasScalarReferences } from "../openapi/references.ts";
import { buildReferenceFiles } from "../openapi/scalar.ts";
import { isOpenApiSource } from "../openapi/source.ts";
import { buildSearchDocuments } from "../search/documents.ts";
import { servesStaticIndex } from "../search/providers.ts";
import {
  examplesEntryTemplate,
  tailwindEntryTemplate,
} from "../theme/entry.ts";
import { buildThemeCss } from "../theme/palette.ts";
import { twoslashCss } from "../theme/twoslash.ts";

const toPosix = (path: string): string => path.split("\\").join("/");

/** The portable `@source` guess: blume in the project's own node_modules. */
const LOCAL_BLUME_SOURCE = "../../node_modules/blume/src/**/*.{astro,ts,tsx}";

/**
 * The `@source` glob pointing Tailwind at Blume's own source, relative to the
 * ejected `src/generated/app.css`. The project-local `node_modules/blume` is
 * preferred (portable, and under pnpm the symlink survives version bumps), but
 * hoisted installs (npm/yarn workspaces lift blume into the workspace root's
 * node_modules) would make that guess match nothing and silently drop utility
 * classes — so fall back to the package's real installed location, and when
 * even that fails, warn instead of failing silently.
 *
 * Exported for testing.
 */
export const blumeSourceGlob = (
  root: string,
  genDir: string,
  resolveBlumeRoot: () => string = packageRoot
): string => {
  if (existsSync(join(root, "node_modules", "blume"))) {
    return LOCAL_BLUME_SOURCE;
  }
  try {
    const src = join(resolveBlumeRoot(), "src");
    return `${toPosix(relative(genDir, src))}/**/*.{astro,ts,tsx}`;
  } catch {
    console.warn(
      'blume: could not locate the installed blume package; src/generated/app.css keeps its default `@source "../../node_modules/blume/..."` glob. If blume is hoisted elsewhere, point that glob at its install location or Blume\'s utility classes will be missing.'
    );
    return LOCAL_BLUME_SOURCE;
  }
};

/** The `blume:openapi` payload for the ejected app (`{}` when none). */
const ejectOpenApiData = (project: BlumeProject): unknown => {
  const source = project.sources.find(isOpenApiSource);
  return source ? source.openApiData() : {};
};

/**
 * The Ask AI endpoint plus, unless the backend runs its own retrieval (Inkeep),
 * its grounding snapshot. Empty when Ask AI is disabled.
 */
const askFiles = async (
  project: BlumeProject,
  srcDir: string,
  genDir: string
): Promise<{ content: string; path: string }[]> => {
  const { ask } = project.config.ai;
  if (!ask?.enabled) {
    return [];
  }
  const grounded = ask.provider !== "inkeep";
  const files = [
    {
      content: askEndpointTemplate(resolveAskBackend(ask), grounded),
      path: join(srcDir, "pages", "api", "ask.ts"),
    },
  ];
  if (grounded) {
    files.push({
      content: `${JSON.stringify(await buildAskData(project))}\n`,
      path: join(genDir, "ask-data.json"),
    });
  }
  return files;
};

/** Whether the ejected app hosts the MCP server (enabled and route free). */
const hostsMcp = (
  project: BlumeProject,
  userPages: { pattern: string }[]
): boolean =>
  project.config.ai.mcp.enabled &&
  !routeIsTaken(userPages, project.graph.pages, project.config.ai.mcp.route);

/**
 * The `.well-known` MCP discovery routes, injected as prerendered pages
 * alongside the user's own so the ejected Astro config wires them in. Empty
 * when the server is disabled or its route is already owned by a page.
 */
const mcpDiscoveryPages = (
  project: BlumeProject,
  userPages: { pattern: string }[]
): { entrypoint: string; pattern: string }[] =>
  hostsMcp(project, userPages)
    ? [
        {
          entrypoint: "src/blume-mcp/discovery.ts",
          pattern: "/.well-known/mcp.json",
        },
        {
          entrypoint: "src/blume-mcp/server-card.ts",
          pattern: "/.well-known/mcp/server-card.json",
        },
      ]
    : [];

/**
 * The MCP data snapshot, server endpoint, and `.well-known` discovery
 * documents, mirroring `writeMcpFiles` in generate.ts. Empty when the server
 * is disabled or its route is already owned by a page.
 */
const mcpFiles = async (
  project: BlumeProject,
  userPages: { pattern: string }[],
  srcDir: string,
  genDir: string
): Promise<{ content: string; path: string }[]> => {
  if (!hostsMcp(project, userPages)) {
    return [];
  }
  const { route } = project.config.ai.mcp;
  const data = await buildMcpData(project);
  const discoveryInput = {
    base: data.base,
    name: data.name,
    route,
    site: data.site,
    version: data.version,
  };
  return [
    {
      content: `${JSON.stringify(data)}\n`,
      path: join(genDir, "mcp-data.json"),
    },
    {
      content: mcpEndpointTemplate(route),
      path: join(srcDir, "pages", mcpPageFile(route)),
    },
    {
      content: staticJsonEndpointTemplate(buildMcpDiscovery(discoveryInput)),
      path: join(srcDir, "blume-mcp", "discovery.ts"),
    },
    {
      content: staticJsonEndpointTemplate(buildMcpServerCard(discoveryInput)),
      path: join(srcDir, "blume-mcp", "server-card.ts"),
    },
  ];
};

/**
 * The `/changelog` index page, mirroring `shouldGenerateChangelog` in
 * generate.ts: emitted when `type: changelog` entries or a release-backed
 * changelog source exist, unless a user page already owns the route.
 */
const changelogFiles = (
  project: BlumeProject,
  userPages: { pattern: string }[],
  srcDir: string,
  options: Parameters<typeof changelogIndexTemplate>[0]
): { content: string; path: string }[] => {
  const hasChangelog = project.graph.pages.some(
    (page) =>
      page.contentType === "changelog" &&
      !(page.meta.draft || page.meta.sidebar.hidden)
  );
  const hasChangelogSource = (project.config.content.sources ?? []).some(
    (source) => source.type === "github-releases"
  );
  if (
    !(hasChangelog || hasChangelogSource) ||
    routeIsTaken(userPages, project.graph.pages, "/changelog")
  ) {
    return [];
  }
  return [
    {
      content: changelogIndexTemplate(options),
      path: join(srcDir, "pages", "changelog.astro"),
    },
  ];
};

/** Contents of the configured `examples.css`, or `""` when unset/absent. */
const readExamplesCss = (
  root: string,
  css: string | undefined
): Promise<string> =>
  css && existsSync(join(root, css))
    ? readFile(join(root, css), "utf-8")
    : Promise.resolve("");

/**
 * The per-example preview route `<Component />` iframes embed, nested under
 * `basePath` so it stays reachable behind a proxy that only forwards the
 * base. Empty when the project has no examples.
 */
const examplesPreviewFiles = (
  srcDir: string,
  basePath: string,
  hasExamples: boolean
): { content: string; path: string }[] =>
  hasExamples
    ? [
        {
          content: examplesPageTemplate(),
          path: join(
            srcDir,
            "pages",
            ...basePath.split("/").filter(Boolean),
            "blume-examples",
            "[...path].astro"
          ),
        },
      ]
    : [];

const ejectIntegrationBridge = (
  config: BlumeProject["config"],
  root: string,
  configFile: string | null
): Parameters<typeof astroConfigTemplate>[0]["integrationBridge"] =>
  config.integrations.length > 0 && configFile
    ? { configFile: toPosix(relative(root, configFile)) }
    : undefined;

/**
 * Promote the generated runtime into the project as an owned Astro app. After
 * eject the project has a normal `astro.config.mjs` and `src/`, the `blume` CLI
 * is no longer required, and the `blume` package remains importable.
 *
 * Returns the written files plus non-fatal warnings, mirroring the generated
 * runtime (e.g. a Scalar reference spec that wasn't found, or a reference
 * route colliding with a content page).
 */
export const eject = async (
  root: string
): Promise<{ files: string[]; warnings: string[] }> => {
  const project = await scanProject(root, { mode: "build" });
  const { context, config } = project;

  const srcDir = join(root, "src");
  const genDir = join(srcDir, "generated");
  const askEnabled = config.ai.ask?.enabled ?? false;
  const exportPdf = config.export.pdf;
  const exportEpub = config.export.epub;

  const [
    pages,
    needsReactRaw,
    usesMath,
    userTheme,
    userExamplesCss,
    rawMarkdown,
    islands,
    examples,
  ] = await Promise.all([
    context.pagesRoot ? discoverPages(context.pagesRoot) : Promise.resolve([]),
    detectNeedsReact(root),
    detectUsesMath(root),
    context.themeFile
      ? readFile(context.themeFile, "utf-8")
      : Promise.resolve(""),
    readExamplesCss(root, config.examples.css),
    buildRawMarkdown(project),
    discoverIslands(root),
    discoverExamples(root, config.examples.source),
  ]);
  // Island/example frameworks drive which Astro renderers the ejected config
  // wires in; React also switches on for project `.tsx`/`.jsx` and Ask AI.
  const frameworks = new Set<string>([
    ...islands.islands.map((island) => island.framework),
    ...examples.examples.map((example) => example.framework),
  ]);
  const needsReact = needsReactRaw || askEnabled || frameworks.has("react");
  const needsVue = frameworks.has("vue");
  const needsSvelte = frameworks.has("svelte");

  // A project-relative context so generated files use portable paths.
  const relContext: ProjectContext = {
    ...context,
    contentRoot: toPosix(relative(root, context.contentRoot)),
    outDir: ".",
    root: ".",
  };

  const componentsImport = context.componentsFile
    ? `../../${toPosix(relative(root, context.componentsFile))}`
    : null;
  const relPages = [
    ...pages.map((page) => ({
      entrypoint: toPosix(relative(root, page.entrypoint)),
      pattern: page.pattern,
    })),
    ...mcpDiscoveryPages(project, pages),
  ];

  // Non-filesystem sources eject their materialized MDX into `<root>/blume-staged`
  // (a dedicated dir so it never clashes with a content root literally named
  // `content`; the relative `staged` collection points there).
  const staged = collectStaged(project);
  const hasStaged = staged.size > 0;
  const stagedDir = "blume-staged";

  const files: {
    path: string;
    content: string;
    /** Don't overwrite a file the user already owns (e.g. a tuned tsconfig). */
    skipIfExists?: boolean;
  }[] = [
    {
      content: astroConfigTemplate({
        askPath: "./src/generated/Ask.astro",
        config,
        contentRoutes: project.manifest.routes.map((route) => route.path),
        context: relContext,
        dataPath: "./src/generated/data.json",
        examplesPath: "./src/generated/examples.ts",
        examplesThemePath: "./src/generated/examples.css",
        integrationBridge: ejectIntegrationBridge(
          config,
          root,
          context.configFile
        ),
        needsReact,
        needsSvelte,
        needsVue,
        openapiPath: "./src/generated/openapi.json",
        pages: relPages,
        searchClientPath: "./src/generated/search-client.ts",
        themePath: "./src/generated/app.css",
      }),
      path: join(root, "astro.config.mjs"),
    },
    {
      content: runtimeTsconfigTemplate(),
      path: join(root, "tsconfig.json"),
      // Never clobber a hand-tuned tsconfig; only write ours if none exists.
      skipIfExists: true,
    },
    { content: envTemplate(), path: join(srcDir, "env.d.ts") },
    {
      content: contentConfigTemplate({
        config,
        context: relContext,
        staged: hasStaged,
        stagedBase: stagedDir,
      }),
      path: join(srcDir, "content.config.ts"),
    },
    {
      content: catchAllPageTemplate({
        exportEpub,
        exportPdf,
        mathEnabled: usesMath,
        needsReact,
      }),
      path: join(srcDir, "pages", "[...slug].astro"),
    },
    {
      // Eject keeps the portable re-export form (relative import to the user's
      // components file); hydration/island wrappers would need machine-specific
      // absolute paths, so the ejected app owns and wires those itself.
      content: planComponentSlots(componentsImport, null).module,
      path: join(genDir, "components.ts"),
    },
    // Island/example maps the catch-all imports; written even when empty so the
    // relative import and the `blume:examples` alias always resolve.
    {
      content: islandMapTemplate(islands.islands),
      path: join(genDir, "islands.ts"),
    },
    {
      content: exampleMapTemplate(examples.examples, config.basePath),
      path: join(genDir, "examples.ts"),
    },
    {
      // The isolated Tailwind entry for `<Component />` preview frames.
      // Relative sources keep the ejected app portable.
      content: examplesEntryTemplate({
        configTokens: buildThemeCss(config.theme),
        sources: ["../../**/*.{astro,jsx,svelte,ts,tsx,vue}"],
        userCss: userExamplesCss,
      }),
      path: join(genDir, "examples.css"),
    },
    {
      content: tailwindEntryTemplate({
        configTokens: buildThemeCss(config.theme),
        // Relative paths from src/generated/app.css keep the ejected app
        // portable; the blume glob resolves the real install location when
        // the package is hoisted out of the project's own node_modules.
        sources: [
          blumeSourceGlob(root, genDir),
          "../../**/*.{astro,mdx,ts,tsx}",
        ],
        twoslashCss: twoslashCss(),
        userTheme,
      }),
      path: join(genDir, "app.css"),
    },
    { content: buildRuntimeData(project), path: join(genDir, "data.json") },
    // The header's Ask trigger behind the `blume:ask` alias. Always written — it
    // renders nothing when Ask is off — so the alias always resolves.
    {
      content: askComponentTemplate(askEnabled),
      path: join(genDir, "Ask.astro"),
    },
    {
      content: `${JSON.stringify(ejectOpenApiData(project))}\n`,
      path: join(genDir, "openapi.json"),
    },
    {
      content: `${JSON.stringify(rawMarkdown)}\n`,
      path: join(genDir, "raw-markdown.json"),
    },
    {
      content: rawMarkdownEndpointTemplate("md"),
      path: join(srcDir, "pages", "[...slug].md.ts"),
    },
    {
      content: rawMarkdownEndpointTemplate("mdx"),
      path: join(srcDir, "pages", "[...slug].mdx.ts"),
    },
  ];

  if (askEnabled) {
    files.push(...(await askFiles(project, srcDir, genDir)));
  }

  if (config.seo.og.enabled) {
    files.push({
      content: ogEndpointTemplate(customOgRoutes(pages, config.title)),
      path: join(srcDir, "pages", "og", "[...slug].png.ts"),
    });
  }

  // The hosted MCP server and the `/changelog` index, mirrored from the
  // generated runtime (each helper returns `[]` when its feature is off).
  files.push(
    ...(await mcpFiles(project, pages, srcDir, genDir)),
    ...changelogFiles(project, pages, srcDir, {
      exportEpub,
      exportPdf,
      needsReact,
      staged: hasStaged,
    })
  );

  // Default 404 page, unless the project already owns `/404` (a custom
  // `pages/404.astro` or a `404.md` content page). The ejected project owns the
  // file afterwards and can edit or remove it.
  if (!routeIsTaken(pages, project.graph.pages, "/404")) {
    files.push({
      content: notFoundPageTemplate(),
      path: join(srcDir, "pages", "404.astro"),
    });
  }

  // The provider-specific client loader behind the `blume:search-client` alias.
  files.push({
    content: searchClientTemplate(config),
    path: join(genDir, "search-client.ts"),
  });

  if (servesStaticIndex(config.search.provider)) {
    const documents = await buildSearchDocuments(project);
    files.push(
      {
        content: `${JSON.stringify(documents)}\n`,
        path: join(genDir, "search.json"),
      },
      {
        content: searchEndpointTemplate(),
        path: join(srcDir, "pages", "blume-search.json.ts"),
      }
    );
  }

  if (config.search.provider === "mixedbread") {
    files.push({
      content: mixedbreadSearchEndpointTemplate(
        config.search.mixedbread?.storeId ?? ""
      ),
      path: join(srcDir, "pages", "api", "search.ts"),
    });
  }

  const feeds = buildRssFeeds(project);
  if (feeds.length > 0) {
    const feedXml = Object.fromEntries(
      feeds.map((feed) => [feed.type, renderRssFeed(feed)])
    );
    files.push(
      {
        content: `${JSON.stringify(feedXml)}\n`,
        path: join(genDir, "rss.json"),
      },
      {
        content: rssEndpointTemplate(),
        path: join(srcDir, "pages", "[section]", "rss.xml.ts"),
      }
    );
  }

  // Scalar API/AsyncAPI reference pages, mirrored from the generated runtime so
  // the ejected app keeps its reference routes — including the warnings (a
  // missing spec file, a route collision), which the caller surfaces exactly
  // like the generated-runtime path does.
  const warnings: string[] = [];
  if (hasScalarReferences(config)) {
    const references = await buildReferenceFiles({
      config,
      contentRoutes: new Set(project.graph.pages.map((page) => page.route)),
      root,
    });
    warnings.push(...references.warnings);
    for (const file of references.files) {
      files.push({
        content: file.content,
        path: join(srcDir, "pages", file.pagePath),
      });
    }
  }

  // Per-island and per-example live wrappers referenced by the maps above.
  files.push(
    ...islands.islands.map((island) => ({
      content: islandWrapperTemplate(island),
      path: join(genDir, "islands", `${island.name}.astro`),
    })),
    ...examples.examples.map((example) => ({
      content: exampleWrapperTemplate(example),
      path: join(genDir, "examples", `${exampleSlug(example.path)}.astro`),
    })),
    ...examplesPreviewFiles(
      srcDir,
      config.basePath,
      examples.examples.length > 0
    )
  );

  // Materialize staged source bodies under `<root>/blume-staged/<source>/<ref>`,
  // matching the relative `staged` collection base in the ejected config.
  for (const [entryId, content] of staged) {
    files.push({ content, path: join(root, stagedDir, entryId) });
  }

  const written = files.filter(
    (file) => !(file.skipIfExists && existsSync(file.path))
  );
  await Promise.all(
    written.map(async (file) => {
      await mkdir(join(file.path, ".."), { recursive: true });
      await writeFile(file.path, file.content, "utf-8");
    })
  );

  // Materialized source assets (e.g. downloaded Notion images) live under the
  // hidden runtime's public dir; copy them into the owned project's `public/`
  // so the staged content's `/blume-assets/…` references still resolve.
  const assetsSrc = join(context.outDir, "public", "blume-assets");
  if (existsSync(assetsSrc)) {
    await cp(assetsSrc, join(root, "public", "blume-assets"), {
      recursive: true,
    });
  }

  // The hidden runtime is no longer the source of truth.
  await rm(context.outDir, { force: true, recursive: true });

  return { files: written.map((file) => file.path), warnings };
};

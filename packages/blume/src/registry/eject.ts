import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { join, relative } from "pathe";

import { OPENAPI_PATH } from "../ai/api/paths.ts";
import { buildApiSpec } from "../ai/api/spec.ts";
import { buildAskData } from "../ai/ask-data.ts";
import { resolveAskBackend } from "../ai/ask.ts";
import { buildRawMarkdown } from "../ai/markdown.ts";
import { buildMcpData } from "../ai/mcp/data.ts";
import type { McpData } from "../ai/mcp/data.ts";
import { buildMcpDiscovery, buildMcpServerCard } from "../ai/mcp/discovery.ts";
import { planComponentSlots } from "../astro/component-slots.ts";
import {
  EXAMPLE_SCAN_GLOB,
  discoverExamples,
  exampleMarkdownLookup,
  exampleScanRoots,
} from "../astro/examples.ts";
import {
  analyzeComponentsFile,
  buildRuntimeData,
  clientFeaturesFor,
  collectStaged,
  detectNeedsReact,
  detectUsesMath,
  languageIconCssFor,
  PLAYGROUND_PROXY_ENTRY,
  playgroundProxyPattern,
  proxyAllowlistWarnings,
  specOrigins,
} from "../astro/generate.ts";
import { discoverIslands } from "../astro/islands.ts";
import { customOgRoutes, discoverPages, routeIsTaken } from "../astro/pages.ts";
import {
  apiNavigationTemplate,
  apiNotFoundTemplate,
  apiPagesIndexTemplate,
  apiPageTemplate,
  apiSearchTemplate,
  askComponentTemplate,
  askEndpointTemplate,
  astroConfigTemplate,
  catchAllPageTemplate,
  changelogIndexTemplate,
  contentAssetsEndpointTemplate,
  contentConfigTemplate,
  exampleMapTemplate,
  exampleSlug,
  examplesPageTemplate,
  exampleWrapperTemplate,
  featuresTemplate,
  mcpEndpointTemplate,
  mcpPageFile,
  mixedbreadSearchEndpointTemplate,
  notFoundJsonTemplate,
  notFoundMarkdownTemplate,
  notFoundPageTemplate,
  ogEndpointTemplate,
  playgroundProxyTemplate,
  rawMarkdownEndpointTemplate,
  rssEndpointTemplate,
  runtimeDependencies,
  runtimeTsconfigTemplate,
  searchClientTemplate,
  searchEndpointTemplate,
  staticJsonEndpointTemplate,
} from "../astro/templates.ts";
import { collectContentAssets } from "../core/content-assets.ts";
import { buildIncludeGraph } from "../core/includes.ts";
import { packageRoot } from "../core/package-root.ts";
import { scanProject } from "../core/project-graph.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import {
  resolveDocsCollection,
  sourcesOfKind,
} from "../core/sources/collection.ts";
import type { ProjectContext } from "../core/types.ts";
import { buildRssFeeds, renderRssFeed } from "../deploy/rss.ts";
import type { OpenApiData } from "../openapi/model.ts";
import {
  hasScalarReferences,
  needsPlaygroundProxy,
} from "../openapi/references.ts";
import { buildReferenceFiles } from "../openapi/scalar.ts";
import { isOpenApiSource } from "../openapi/source.ts";
import { buildSearchDocuments } from "../search/documents.ts";
import {
  examplesEntryTemplate,
  tailwindEntryTemplate,
} from "../theme/entry.ts";
import { buildThemeCss } from "../theme/palette.ts";
import { rebaseSourceDirectives } from "../theme/sources.ts";
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
const ejectOpenApiData = (project: BlumeProject): OpenApiData => {
  const source = project.sources.find(isOpenApiSource);
  return source ? source.openApiData() : {};
};

/**
 * The assistant endpoint plus, unless the backend runs its own retrieval (Inkeep),
 * its grounding snapshot. Empty when the assistant is disabled.
 */
const askFiles = async (
  project: BlumeProject,
  srcDir: string,
  genDir: string
): Promise<{ content: string; path: string }[]> => {
  const { assistant } = project.config.ai;
  if (!(assistant?.enabled && !assistant.endpoint)) {
    const endpointPath = join(srcDir, "pages", "api", "ask.ts");
    if (existsSync(endpointPath)) {
      const content = await readFile(endpointPath, "utf-8");
      if (content.startsWith("// Generated by Blume. Do not edit.")) {
        await rm(endpointPath, { force: true });
      }
    }
    await rm(join(genDir, "ask-data.json"), { force: true });
    return [];
  }
  const backend = resolveAskBackend(assistant.provider);
  const files = [
    {
      content: askEndpointTemplate(backend, {
        cors: assistant.cors,
        instructions: assistant.instructions,
        retrieval: assistant.retrieval,
      }),
      path: join(srcDir, "pages", "api", "ask.ts"),
    },
  ];
  if (backend.grounded) {
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
  project.config.agents.mcp.enabled &&
  !routeIsTaken(
    userPages,
    project.graph.pages,
    project.config.agents.mcp.route
  );

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
 * The playground's built-in CORS proxy route (`playground: { proxy: true }`),
 * mirroring `planPlaygroundProxy` in generate.ts: injected like the MCP
 * discovery routes, because Astro treats a `_`-prefixed page file as private,
 * and mounted under `basePath` at the URL the playground sends to. Empty when
 * no reference routes its playground through it.
 */
const playgroundProxyPages = (
  config: BlumeProject["config"]
): { entrypoint: string; pattern: string }[] =>
  needsPlaygroundProxy(config)
    ? [
        {
          entrypoint: toPosix(join("src", PLAYGROUND_PROXY_ENTRY)),
          pattern: playgroundProxyPattern(config),
        },
      ]
    : [];

/**
 * The proxy endpoint behind {@link playgroundProxyPages}, with the origin
 * allowlist baked in from the same parsed specs the reference pages render.
 */
const playgroundProxyFiles = (
  config: BlumeProject["config"],
  openApiData: OpenApiData,
  srcDir: string
): { content: string; path: string }[] =>
  needsPlaygroundProxy(config)
    ? [
        {
          content: playgroundProxyTemplate(specOrigins(openApiData)),
          path: join(srcDir, PLAYGROUND_PROXY_ENTRY),
        },
      ]
    : [];

/**
 * The agent data snapshot (`blume:mcp-data`) behind the MCP server and the
 * JSON docs API, mirroring `publishAgentData` in generate.ts: built when
 * either is on, null when neither needs it.
 */
const ejectAgentData = async (
  project: BlumeProject,
  userPages: { pattern: string }[]
): Promise<McpData | null> =>
  hostsMcp(project, userPages) || project.config.agents.api
    ? await buildMcpData(project)
    : null;

/**
 * The MCP server endpoint and `.well-known` discovery documents, mirroring
 * `writeMcpFiles` in generate.ts. Empty when the server is disabled or its
 * route is already owned by a page.
 */
const mcpFiles = (
  project: BlumeProject,
  userPages: { pattern: string }[],
  srcDir: string,
  data: McpData | null
): { content: string; path: string }[] => {
  if (!(data && hostsMcp(project, userPages))) {
    return [];
  }
  const { route } = project.config.agents.mcp;
  const discoveryInput = {
    base: data.base,
    name: data.name,
    route,
    site: data.site,
    version: data.version,
  };
  return [
    {
      content: mcpEndpointTemplate(),
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
 * The JSON docs API, mirroring `planApi` and `writeApiFiles` in generate.ts:
 * the prerendered page index, per-page documents, and navigation; on server
 * output the search endpoint and, unless a user page or a content page already
 * lives under `/api/`, the JSON 404 catch-all; and `/openapi.json`, unless a
 * `public/openapi.json` or a page owns that route. The ejected `llms.txt`,
 * homepage `Link` header, and 404 page advertise these routes, so the ejected
 * app serves them. Empty when `agents.api` is off.
 */
const apiFiles = (
  project: BlumeProject,
  userPages: { pattern: string }[],
  root: string,
  srcDir: string,
  data: McpData | null
): { content: string; path: string }[] => {
  const { config } = project;
  if (!(data && config.agents.api)) {
    return [];
  }
  const server = config.deployment.options.output === "server";
  const apiDir = join(srcDir, "pages", "api");
  const files = [
    {
      content: apiPagesIndexTemplate(),
      path: join(apiDir, "docs", "pages.json.ts"),
    },
    {
      content: apiPageTemplate(),
      path: join(apiDir, "docs", "pages", "[...route].json.ts"),
    },
    {
      content: apiNavigationTemplate(),
      path: join(apiDir, "docs", "navigation.json.ts"),
    },
  ];
  if (server) {
    files.push({
      content: apiSearchTemplate(),
      path: join(apiDir, "docs", "search.ts"),
    });
  }
  const apiOwned =
    userPages.some((page) => page.pattern.startsWith("/api/[")) ||
    project.graph.pages.some(
      (page) => page.route === "/api" || page.route.startsWith("/api/")
    );
  if (server && !apiOwned) {
    files.push({
      content: apiNotFoundTemplate({ base: data.base, site: data.site }),
      path: join(apiDir, "[...path].ts"),
    });
  }
  if (
    !(
      routeIsTaken(userPages, project.graph.pages, OPENAPI_PATH) ||
      existsSync(join(root, "public", "openapi.json"))
    )
  ) {
    files.push({
      content: staticJsonEndpointTemplate(
        buildApiSpec({
          agentReadability: config.agents.agentReadability,
          base: data.base,
          description: config.description,
          llmsTxt: config.agents.llmsTxt.enabled,
          mcpRoute: hostsMcp(project, userPages)
            ? config.agents.mcp.route
            : null,
          name: config.title,
          search: server,
          site: data.site,
          version: data.version,
        })
      ),
      path: join(srcDir, "pages", "openapi.json.ts"),
    });
  }
  return files;
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
  const hasChangelogSource =
    sourcesOfKind(project.config, "github-releases").length > 0;
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

/**
 * The colocated-image map and the `/blume-assets/[...asset]` endpoint that
 * serves it, mirroring generate.ts: the ejected raw Markdown points
 * `![x](./diagram.png)` at `/blume-assets/content/…`, and the config aliases
 * `blume:content-assets` to the map. Each original's path is written relative
 * to the project root (the directory `astro dev`/`astro build` run from), so
 * the ejected app builds from any checkout. Remote-source images need no
 * endpoint: eject copies them into the project's own `public/blume-assets`.
 */
const contentAssetFiles = async (
  project: BlumeProject,
  root: string,
  srcDir: string,
  genDir: string
): Promise<{ content: string; path: string }[]> => {
  const assets = await collectContentAssets(project);
  const portable = Object.fromEntries(
    Object.entries(assets).map(([param, abs]) => [
      param,
      toPosix(relative(root, abs)),
    ])
  );
  return [
    {
      content: `${JSON.stringify(portable)}\n`,
      path: join(genDir, "content-assets.json"),
    },
    {
      content: contentAssetsEndpointTemplate(null),
      path: join(srcDir, "pages", "blume-assets", "[...asset].ts"),
    },
  ];
};

/**
 * The partial → including-pages map with every path relative to the project
 * root, like every other path in the ejected app, so it holds in any checkout.
 * Its readers (`includeHmrPlugin`, `withIncludeRefresh`) resolve each path
 * against the app's root, which after eject is the project itself.
 */
const portableIncludeGraph = (
  project: BlumeProject,
  root: string
): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(buildIncludeGraph(project.graph.pages)).map(
      ([partial, includers]) => [
        toPosix(relative(root, partial)),
        includers.map((page) => toPosix(relative(root, page))),
      ]
    )
  );

/** Contents of the configured `examples.css`, or `""` when unset/absent. */
/**
 * Read a user stylesheet that eject inlines into a generated entry under
 * `genDir`, re-rooting its relative `@source` paths from the user's file.
 * Resolves to an empty string when the file is unset or absent.
 */
const readUserCss = async (
  file: string | null,
  genDir: string
): Promise<string> => {
  if (!(file && existsSync(file))) {
    return "";
  }
  const css = await readFile(file, "utf-8");
  return rebaseSourceDirectives(css, { from: file, to: genDir });
};

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

/**
 * The packages the ejected app imports by bare name: Astro, Tailwind's Vite
 * plugin, Tailwind and its typography plugin (which the generated `app.css`
 * and `examples.css` import by name), `blume` itself, the integrations the
 * config wires in, whatever the configured adapters declare, and React when
 * islands, examples, or the assistant render with it (Blume ships React, so
 * projects rarely list it). They have to be the project's own dependencies
 * after eject — under a strict linker such as pnpm nothing else makes them
 * resolvable, and `astro build` fails. The hidden runtime reaches the same
 * packages through its `node_modules` junction into Blume's own, so only
 * eject declares the ones its generated files import directly: the AI SDK the
 * assistant route streams through (unless `ai.assistant.endpoint` points
 * elsewhere, when no route is written) and the EPUB generator's browser bundle
 * `features.ts` loads (only named there when `export.epub` is on).
 */
const ejectDependencies = (
  options: Parameters<typeof runtimeDependencies>[0]
): string[] => {
  const { assistant } = options.config.ai;
  return [
    ...new Set([
      "astro",
      "@tailwindcss/vite",
      "tailwindcss",
      "@tailwindcss/typography",
      "blume",
      ...runtimeDependencies(options),
      ...(options.needsReact ? ["react", "react-dom"] : []),
      ...(assistant?.enabled && !assistant.endpoint ? ["ai"] : []),
      ...(options.config.export.epub ? ["epub-gen-memory"] : []),
    ]),
  ];
};

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
 * route colliding with a content page), and the packages the ejected app
 * imports by bare name, for the caller to add to package.json.
 */
export const eject = async (
  root: string
): Promise<{ dependencies: string[]; files: string[]; warnings: string[] }> => {
  const project = await scanProject(root, { mode: "build" });
  const { context, config } = project;

  const srcDir = join(root, "src");
  const genDir = join(srcDir, "generated");
  const assistantEnabled = config.ai.assistant?.enabled ?? false;
  const exportPdf = config.export.pdf;
  const exportEpub = config.export.epub;

  // Discover examples first and expose them on the project, so the agent-facing
  // Markdown built below (raw `.md`, MCP) downlevels `<Component>` to its source.
  const examples = await discoverExamples(root, config.examples.source);
  project.examples = exampleMarkdownLookup(examples.examples);

  const [
    pages,
    needsReactRaw,
    usesMath,
    userTheme,
    userExamplesCss,
    rawMarkdown,
    islands,
    overrideAnalysis,
  ] = await Promise.all([
    context.pagesRoot ? discoverPages(context.pagesRoot) : Promise.resolve([]),
    detectNeedsReact(root),
    detectUsesMath(root),
    readUserCss(context.themeFile, genDir),
    readUserCss(
      config.examples.css ? join(root, config.examples.css) : null,
      genDir
    ),
    buildRawMarkdown(project),
    discoverIslands(root),
    analyzeComponentsFile(context.componentsFile),
  ]);
  // The `islands/` convention and `components.ts` share the same static plan
  // the CLI uses, with every import written relative to its generated file so
  // the ejected app builds from any checkout (like the example wrappers below).
  const slotPlan = planComponentSlots(islands.islands, overrideAnalysis, {
    relativeTo: genDir,
  });
  // Island/example/override frameworks drive which Astro renderers the ejected
  // config wires in; React also switches on for project `.tsx`/`.jsx` and the assistant.
  const frameworks = new Set<string>([
    ...islands.islands.map((island) => island.framework),
    ...examples.examples.map((example) => example.framework),
    ...slotPlan.frameworks,
  ]);
  const needsReact =
    needsReactRaw || assistantEnabled || frameworks.has("react");
  const needsVue = frameworks.has("vue");
  const needsSvelte = frameworks.has("svelte");

  // A project-relative context so generated files use portable paths.
  const relContext: ProjectContext = {
    ...context,
    contentRoot: toPosix(relative(root, context.contentRoot)),
    distDir: "./dist",
    outDir: ".",
    pagesRoot: context.pagesRoot
      ? `./${toPosix(relative(root, context.pagesRoot))}`
      : null,
    root: ".",
  };
  // The `docs` collection resolves its base against the real project root and
  // is then relativized like everything else, so the ejected content config
  // never bakes in the absolute path `eject` happened to run from.
  const docsCollection = resolveDocsCollection(config, root);
  const relCollection = {
    ...docsCollection,
    base: toPosix(relative(root, docsCollection.base)),
  };

  const relPages = [
    ...pages.map((page) => ({
      entrypoint: toPosix(relative(root, page.entrypoint)),
      pattern: page.pattern,
    })),
    ...mcpDiscoveryPages(project, pages),
    ...playgroundProxyPages(config),
  ];
  const openApiData = ejectOpenApiData(project);

  // Non-filesystem sources eject their materialized MDX into `<root>/blume-staged`
  // (a dedicated dir so it never clashes with a content root literally named
  // `content`; the relative `staged` collection points there).
  const staged = collectStaged(project);
  const hasStaged = staged.size > 0;
  const stagedDir = "blume-staged";
  const features = await clientFeaturesFor(project);
  const languageIcons = await languageIconCssFor(project);

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
        contentRoot: relContext.contentRoot,
        contentRoutes: project.manifest.routes.map((route) => route.path),
        context: relContext,
        examplesPath: "./src/generated/examples.ts",
        examplesThemePath: "./src/generated/examples.css",
        features,
        featuresPath: "./src/generated/features.ts",
        // No CLI publishes the runtime data modules in memory after eject, so
        // the config aliases each to the JSON snapshot written below.
        generatedModulesDir: "./src/generated",
        integrationBridge: ejectIntegrationBridge(
          config,
          root,
          context.configFile
        ),
        needsReact,
        needsSvelte,
        needsVue,
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
    {
      content: contentConfigTemplate({
        collection: relCollection,
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
      content: slotPlan.module,
      path: join(genDir, "components.ts"),
    },
    // The example map the catch-all imports; written even when empty so the
    // `blume:examples` alias always resolves.
    {
      content: exampleMapTemplate(examples.examples, config.basePath),
      path: join(genDir, "examples.ts"),
    },
    {
      // The isolated Tailwind entry for `<Component />` preview frames.
      // Relative sources keep the ejected app portable.
      content: examplesEntryTemplate({
        configTokens: buildThemeCss(config.theme),
        sources: exampleScanRoots(root, examples.dir).map(
          (dir) => `${relative(genDir, dir)}/${EXAMPLE_SCAN_GLOB}`
        ),
        userCss: userExamplesCss,
      }),
      path: join(genDir, "examples.css"),
    },
    {
      content: tailwindEntryTemplate({
        configTokens: buildThemeCss(config.theme),
        languageIcons,
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
      content: askComponentTemplate(assistantEnabled),
      path: join(genDir, "Ask.astro"),
    },
    {
      content: `${JSON.stringify(openApiData)}\n`,
      path: join(genDir, "openapi.json"),
    },
    {
      content: `${JSON.stringify(rawMarkdown)}\n`,
      path: join(genDir, "raw-markdown.json"),
    },
    {
      // The partial → including-pages map behind `includeHmrPlugin`, which the
      // ejected astro.config wires at this exact path — without the file every
      // hot update's read would silently no-op and partial edits would serve
      // stale pages. A snapshot like the rest of `src/generated`: the ejected
      // app owns (and may regenerate or prune) it.
      content: `${JSON.stringify(portableIncludeGraph(project, root))}\n`,
      path: join(genDir, "includes.json"),
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

  files.push(...(await contentAssetFiles(project, root, srcDir, genDir)));

  if (assistantEnabled) {
    files.push(...(await askFiles(project, srcDir, genDir)));
  }

  // The `/changelog` index, mirrored from the generated runtime (`[]` when
  // the project has no changelog). The OG endpoint below adds its card.
  const changelog = changelogFiles(project, pages, srcDir, {
    exportEpub,
    exportPdf,
    needsReact,
    staged: hasStaged,
  });

  if (config.seo.og.enabled) {
    files.push({
      content: ogEndpointTemplate(
        customOgRoutes(pages, config.title, config.seo.og.titles),
        { pageDescriptions: config.seo.og.description !== false },
        changelog.length > 0
      ),
      path: join(srcDir, "pages", "og", "[...slug].png.ts"),
    });
  }

  // The hosted MCP server, the JSON docs API, and the playground's built-in
  // proxy, mirrored from the generated runtime (`[]` when each is off). The
  // server and the API share one agent data snapshot.
  const agentData = await ejectAgentData(project, pages);
  if (agentData) {
    files.push({
      content: `${JSON.stringify(agentData)}\n`,
      path: join(genDir, "mcp-data.json"),
    });
  }
  files.push(
    ...mcpFiles(project, pages, srcDir, agentData),
    ...apiFiles(project, pages, root, srcDir, agentData),
    ...changelog,
    ...playgroundProxyFiles(config, openApiData, srcDir)
  );

  // Default 404 page and its Markdown (`/404.md`) and JSON (`/404.json`)
  // twins, mirroring `writeNotFoundPage` in generate.ts: all three are skipped
  // when the project already owns `/404` (a custom `pages/404.astro` or a
  // `404.md` content page). The ejected project owns the files afterwards and
  // can edit or remove them.
  if (!routeIsTaken(pages, project.graph.pages, "/404")) {
    files.push(
      {
        content: notFoundPageTemplate(),
        path: join(srcDir, "pages", "404.astro"),
      },
      {
        content: notFoundMarkdownTemplate(),
        path: join(srcDir, "pages", "404.md.ts"),
      },
      {
        content: notFoundJsonTemplate(),
        path: join(srcDir, "pages", "404.json.ts"),
      }
    );
  }

  // The client-feature loaders behind the `blume:features` alias, and the
  // provider-specific client loader behind `blume:search-client`.
  files.push(
    {
      content: featuresTemplate(features),
      path: join(genDir, "features.ts"),
    },
    {
      content: searchClientTemplate(config),
      path: join(genDir, "search-client.ts"),
    }
  );

  const searchAdapter = config.search.provider;
  if (searchAdapter.mode === "static") {
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

  if (searchAdapter.kind === "mixedbread") {
    files.push({
      content: mixedbreadSearchEndpointTemplate(searchAdapter.options),
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
  // A proxied spec with no origin to allow gets the generated runtime's
  // diagnostic too.
  const warnings: string[] = proxyAllowlistWarnings(config, openApiData);
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

  // Per-override and per-example live wrappers referenced by the maps above.
  files.push(
    ...slotPlan.wrappers.map((wrapper) => ({
      content: wrapper.content,
      path: join(genDir, "component-slots", `${wrapper.name}.astro`),
    })),
    ...examples.examples.map((example) => ({
      content: exampleWrapperTemplate(example, join(genDir, "examples")),
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

  return {
    dependencies: ejectDependencies({
      config,
      needsReact,
      needsSvelte,
      needsVue,
    }),
    files: written.map((file) => file.path),
    warnings,
  };
};

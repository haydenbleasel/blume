import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { dirname, join, normalize, relative } from "pathe";
import { glob } from "tinyglobby";

import { resolveAskBackend } from "../ai/ask.ts";
import { buildRawMarkdown } from "../ai/markdown.ts";
import { buildMcpData } from "../ai/mcp/data.ts";
import { buildMcpDiscovery, buildMcpServerCard } from "../ai/mcp/discovery.ts";
import { EN_UI, resolveUIStrings } from "../core/i18n-ui.ts";
import { resolveFallbackLocale } from "../core/i18n.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import type { Navigation } from "../core/types.ts";
import { buildRssFeeds, renderRssFeed } from "../deploy/rss.ts";
import {
  buildReferenceFiles,
  hasReferences,
  referenceTabs,
} from "../openapi/scalar.ts";
import { buildSearchDocuments } from "../search/documents.ts";
import { searchProviderMeta, servesStaticIndex } from "../search/providers.ts";
import { tailwindEntryTemplate } from "../theme/entry.ts";
import { buildFontsCss, configuredCssVars } from "../theme/fonts.ts";
import { buildThemeCss } from "../theme/palette.ts";
import { twoslashCss } from "../theme/twoslash.ts";
import { discoverIslands } from "./islands.ts";
import { discoverPages } from "./pages.ts";
import {
  askEndpointTemplate,
  astroConfigTemplate,
  catchAllPageTemplate,
  changelogIndexTemplate,
  contentConfigTemplate,
  envTemplate,
  islandMapTemplate,
  islandWrapperTemplate,
  mcpEndpointTemplate,
  mcpPageFile,
  mixedbreadSearchEndpointTemplate,
  ogEndpointTemplate,
  rawMarkdownEndpointTemplate,
  rssEndpointTemplate,
  staticJsonEndpointTemplate,
  runtimeDependencies,
  runtimePackageTemplate,
  runtimeTsconfigTemplate,
  searchClientTemplate,
  searchEndpointTemplate,
  stagedContentDir,
  userComponentsTemplate,
} from "./templates.ts";

/** Absolute path to the Blume package `src` directory. */
const BLUME_SRC = fileURLToPath(new URL("..", import.meta.url));
/** The Blume package's own `node_modules` (where Astro and friends live). */
const BLUME_NODE_MODULES = join(BLUME_SRC, "..", "node_modules");

/** Whether a module specifier resolves from a directory via node resolution. */
const canResolveFrom = (fromDir: string, spec: string): boolean => {
  try {
    createRequire(pathToFileURL(join(fromDir, "_.js")).href).resolve(spec);
    return true;
  } catch {
    return false;
  }
};

/** Whether Astro resolves from a directory via normal node resolution. */
const canResolveAstro = (fromDir: string): boolean =>
  canResolveFrom(fromDir, "astro/package.json");

/**
 * Make the generated runtime resolve Astro and its integrations. When they are
 * hoisted into the project (the usual case for published installs), resolution
 * already works. When they are nested and unreachable (workspaces, strict
 * package managers), symlink Blume's own dependencies into `.blume`.
 */
const ensureDepsLink = async (outDir: string): Promise<void> => {
  if (canResolveAstro(outDir)) {
    return;
  }
  if (!existsSync(join(BLUME_NODE_MODULES, "astro"))) {
    return;
  }
  const link = join(outDir, "node_modules");
  if (existsSync(link)) {
    return;
  }
  await mkdir(outDir, { recursive: true });
  await symlink(BLUME_NODE_MODULES, link, "junction");
};

/** Astro integration package each non-React island framework needs installed. */
const ISLAND_FRAMEWORK_DEPS: Record<string, string> = {
  svelte: "@astrojs/svelte",
  vue: "@astrojs/vue",
};

/**
 * Warn when a Vue/Svelte island is present but its Astro integration isn't
 * installed — Vite would otherwise fail opaquely on the generated config import.
 * React ships with Blume, so it never needs this.
 */
const islandFrameworkWarnings = (
  frameworks: Set<string>,
  root: string
): string[] => {
  const warnings: string[] = [];
  for (const framework of frameworks) {
    const dep = ISLAND_FRAMEWORK_DEPS[framework];
    if (dep && !canResolveFrom(root, dep)) {
      warnings.push(
        `Islands use ${framework}, which needs "${dep}". Install it (e.g. \`npm install ${dep} ${framework}\`).`
      );
    }
  }
  return warnings;
};

/** Read a file's contents, or return an empty string if it is absent. */
const readOptional = async (path: string | null): Promise<string> => {
  if (!path) {
    return "";
  }
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
};

/** Heuristically detect whether the project uses React islands. */
export const detectNeedsReact = async (root: string): Promise<boolean> => {
  const matches = await glob(["**/*.{tsx,jsx}"], {
    cwd: root,
    ignore: ["**/node_modules/**", "**/.blume/**", "**/dist/**"],
    onlyFiles: true,
  });
  return matches.length > 0;
};

const writeIfChanged = async (
  path: string,
  content: string
): Promise<boolean> => {
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf-8");
  } catch {
    existing = null;
  }
  if (existing === content) {
    return false;
  }
  await mkdir(dirname(path), { recursive: true });
  // Write to a temp file then atomically rename into place, so a watching dev
  // server never observes a missing or half-written file mid-regeneration.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content, "utf-8");
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return true;
};

/**
 * Delete generated files under `srcDir` that this pass didn't (re)write. The
 * generator emits many files conditionally — an Ask AI endpoint, OG images, a
 * search index, RSS feeds, reference pages, the MCP server — so toggling a
 * feature off would otherwise leave a stale file behind, and a leftover
 * server-rendered endpoint breaks the static build. `writeIfChanged` only ever
 * adds or updates, so this closes the loop. Scoped to `.blume/src`, so it never
 * touches Astro's `dist/`, `.astro/` cache, or the symlinked `node_modules`
 * (all of which live outside `src`). `written` holds normalized absolute paths.
 */
export const pruneOrphans = async (
  srcDir: string,
  written: Set<string>
): Promise<void> => {
  const existing = await glob("**/*", {
    absolute: true,
    cwd: srcDir,
    onlyFiles: true,
  });
  await Promise.all(
    existing
      .map((path) => normalize(path))
      .filter((path) => !written.has(path))
      .map((path) => rm(path, { force: true }))
  );
};

/**
 * Collect staged (non-filesystem) page bodies keyed by their Astro entry id, so
 * i18n duplicates of one entry collapse to a single materialized file. Shared
 * with `eject`, which materializes the same bodies into the owned project.
 */
export const collectStaged = (project: BlumeProject): Map<string, string> => {
  const staged = new Map<string, string>();
  for (const page of project.graph.pages) {
    if (page.collection === "staged" && page.entryId && page.body) {
      staged.set(page.entryId, page.body.text);
    }
  }
  return staged;
};

/**
 * Materialize staged source bodies under `.blume/content` and prune orphans in
 * that tree (separate from `.blume/src`), so a removed remote entry is cleaned up.
 */
const writeStagedContent = async (
  out: string,
  staged: Map<string, string>
): Promise<void> => {
  const contentDir = stagedContentDir(out);
  const written = new Set<string>();
  await Promise.all(
    [...staged].map(async ([entryId, text]) => {
      const path = join(contentDir, entryId);
      written.add(normalize(path));
      await writeIfChanged(path, text);
    })
  );
  if (existsSync(contentDir)) {
    await pruneOrphans(contentDir, written);
  }
};

/** The logo shape the runtime consumes: an inline SVG or image URL(s). */
interface ResolvedLogo {
  svg?: string;
  light?: string;
  dark?: string;
  alt: string;
  href: string;
}

/**
 * Resolve the configured logo. A single SVG is read and inlined so a
 * `currentColor` logo follows the theme; other images keep their URL for an
 * `<img>`. The file is looked up under `public/` and the project root.
 */
const resolveLogo = (project: BlumeProject): ResolvedLogo | null => {
  const { logo } = project.config;
  if (!logo) {
    return null;
  }
  const config = typeof logo === "string" ? { light: logo } : logo;
  const light = config.light ?? config.dark;
  const dark = config.dark ?? config.light;
  const alt = config.alt ?? "";
  const href = config.href ?? "/";

  if (light && light === dark && light.toLowerCase().endsWith(".svg")) {
    const rel = light.replace(/^\//u, "");
    const file = [
      join(project.context.root, "public", rel),
      join(project.context.root, rel),
    ].find((path) => existsSync(path));
    if (file) {
      return { alt, href, svg: readFileSync(file, "utf-8") };
    }
  }
  return { alt, dark, href, light };
};

/** The favicon shape the runtime consumes: a link href plus optional MIME type. */
interface ResolvedFavicon {
  href: string;
  type?: string;
}

/**
 * Favicon filenames Blume auto-detects, in priority order. Mirrors the Next.js
 * convention: an `icon.*` or `favicon.*` file in `public/` or the project root
 * becomes the site favicon, no config required.
 */
const FAVICON_CANDIDATES = [
  "icon.svg",
  "favicon.svg",
  "icon.png",
  "favicon.png",
  "favicon.ico",
  "icon.ico",
];

/** `<link type>` MIME for the favicon extensions we recognize. */
const FAVICON_TYPES: Record<string, string> = {
  ico: "image/x-icon",
  png: "image/png",
  svg: "image/svg+xml",
};

/** Infer the `<link type>` MIME from a filename, when we recognize the extension. */
const faviconType = (name: string): string | undefined => {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext ? FAVICON_TYPES[ext] : undefined;
};

/** Read a file and encode it as a `data:` URI of the given MIME type. */
const inlineDataUri = (file: string, type: string): string =>
  `data:${type};base64,${readFileSync(file).toString("base64")}`;

/** The bundled Blume favicon, inlined as a data URI so it needs no public file. */
const defaultFavicon = (): ResolvedFavicon => ({
  href: inlineDataUri(join(BLUME_SRC, "assets", "icon.png"), "image/png"),
  type: "image/png",
});

/**
 * Resolve the site favicon by convention. An `icon.*`/`favicon.*` file in
 * `public/` is served as-is and referenced by URL; one at the project root is
 * inlined as a data URI (the root isn't a served directory). Falls back to the
 * bundled Blume mark when the project ships no icon.
 */
const resolveFavicon = (project: BlumeProject): ResolvedFavicon => {
  const { root } = project.context;
  for (const name of FAVICON_CANDIDATES) {
    if (existsSync(join(root, "public", name))) {
      return { href: `/${name}`, type: faviconType(name) };
    }
  }
  for (const name of FAVICON_CANDIDATES) {
    const file = join(root, name);
    if (existsSync(file)) {
      const type = faviconType(name);
      return { href: inlineDataUri(file, type ?? "image/x-icon"), type };
    }
  }
  return defaultFavicon();
};

/** The announcement banner shape the runtime consumes. */
interface ResolvedBanner {
  content: string;
  link?: { href: string; text: string };
  dismissible: boolean;
  /** Dismissal key: the configured id, else the content itself. */
  key: string;
}

/** Normalize the banner config (string shorthand or object) for the runtime. */
const resolveBanner = (config: ResolvedConfig): ResolvedBanner | null => {
  const { banner } = config;
  if (!banner) {
    return null;
  }
  if (typeof banner === "string") {
    return { content: banner, dismissible: false, key: banner };
  }
  return {
    content: banner.content,
    dismissible: banner.dismissible,
    key: banner.id ?? banner.content,
    link: banner.link,
  };
};

/** Serialize the content graph into the data module the runtime consumes. */
export const buildRuntimeData = (project: BlumeProject): string => {
  const { config, context, graph, manifest } = project;
  const { github } = config;
  const repoUrl = github
    ? `https://github.com/${github.owner}/${github.repo}`
    : null;
  const editBase = github ? `${repoUrl}/edit/${github.branch}` : null;

  const editUrlFor = (sourcePath?: string): string | null => {
    if (!(editBase && sourcePath)) {
      return null;
    }
    const rel = relative(context.root, sourcePath).split("\\").join("/");
    return `${editBase}/${github?.dir ? `${github.dir}/${rel}` : rel}`;
  };

  const { i18n } = config;

  // API reference routes (Scalar) surface as header tabs alongside the
  // content-derived ones, so the reference stays discoverable in every locale.
  const withReferenceTabs = (nav: Navigation): Navigation => ({
    ...nav,
    repoUrl: config.navigation.repo && repoUrl ? repoUrl : null,
    tabs: [...nav.tabs, ...referenceTabs(config)],
  });

  // Resolved UI dictionaries: one per locale under i18n, English baseline
  // otherwise. Threaded into chrome so the catch-all can pick the active locale.
  const uiByLocale = i18n
    ? Object.fromEntries(
        i18n.locales.map(({ code }) => [
          code,
          resolveUIStrings(code, {
            defaultLocale: i18n.defaultLocale,
            overrides: i18n.ui,
          }),
        ])
      )
    : {};
  const defaultUi = i18n
    ? resolveUIStrings(i18n.defaultLocale, {
        defaultLocale: i18n.defaultLocale,
        overrides: i18n.ui,
      })
    : EN_UI;

  const navigationByLocale = i18n
    ? Object.fromEntries(
        i18n.locales.map(({ code }) => [
          code,
          withReferenceTabs(
            graph.navigationByLocale[code] ?? {
              chromeVariants: [],
              selectors: [],
              sidebar: [],
              sidebarVariants: [],
              tabs: [],
            }
          ),
        ])
      )
    : {};

  const data = {
    config: {
      banner: resolveBanner(config),
      codeWrap: config.markdown.code.wrap,
      description: config.description,
      favicon: resolveFavicon(project),
      i18n: i18n
        ? {
            defaultLocale: i18n.defaultLocale,
            // The locale fallback content is rendered from, so the catch-all can
            // set the content direction to the language it's actually written in.
            fallbackLocale: resolveFallbackLocale(i18n),
            hideDefaultLocalePrefix: i18n.hideDefaultLocalePrefix,
            locales: i18n.locales.map(({ code, dir, label }) => ({
              code,
              dir,
              label,
            })),
          }
        : null,
      imageZoom: config.markdown.imageZoom,
      logo: resolveLogo(project),
      mcp: config.mcp.enabled
        ? { name: config.mcp.name ?? config.title, route: config.mcp.route }
        : null,
      og: { enabled: config.seo.og.enabled },
      repoUrl,
      search: {
        enabled: config.search.provider !== "none",
        provider: config.search.provider,
      },
      site: config.deployment.site ?? null,
      structuredData: config.seo.structuredData,
      theme: config.theme,
      title: config.title,
    },
    feeds: buildRssFeeds(project).map((feed) => ({
      href: feed.path,
      title: feed.title,
    })),
    // CSS variables for Astro's <Font> component; matches the astro.config
    // `fonts:` entries derived from the same theme.fonts config.
    fontCssVars: configuredCssVars(config.theme.fonts),
    navigation: withReferenceTabs(graph.navigation),
    // Per-locale navigation; the catch-all selects the active locale's tree.
    navigationByLocale,
    routes: manifest.routes.map((route) => ({
      alternates: route.alternates,
      collection: route.collection,
      draft: route.draft,
      editUrl: route.editUrl ?? editUrlFor(route.sourcePath),
      entryId: route.entryId,
      fallback: route.fallback ?? false,
      hidden: route.hidden,
      id: route.id,
      indexable: route.indexable,
      lastModified: route.lastModified ?? null,
      locale: route.locale,
      path: route.path,
      title: route.title,
    })),
    // Default-locale chrome strings (English baseline when not under i18n).
    ui: defaultUi,
    // Per-locale chrome strings, selected by the catch-all under i18n.
    uiByLocale,
  };
  return `${JSON.stringify(data, null, 2)}\n`;
};

/** The resolved plan for the hosted MCP server within a single generate pass. */
interface McpPlan {
  /** Directory holding the injected discovery endpoints (`.blume/src/blume-mcp`). */
  dir: string;
  /** `.well-known` discovery routes to inject as prerendered pages. */
  discoveryPages: { entrypoint: string; pattern: string }[];
  enabled: boolean;
  route: string;
  srcDir: string;
  warnings: string[];
}

/**
 * Decide whether (and how) to generate the MCP server. Skipped — with a
 * warning — when a content page already occupies its route, so the user's page
 * keeps working.
 */
const planMcp = (project: BlumeProject, srcDir: string): McpPlan => {
  const { config } = project;
  const { route } = config.mcp;
  const dir = join(srcDir, "blume-mcp");
  const base: McpPlan = {
    dir,
    discoveryPages: [],
    enabled: false,
    route,
    srcDir,
    warnings: [],
  };
  if (!config.mcp.enabled) {
    return base;
  }
  if (project.graph.pages.some((page) => page.route === route)) {
    return {
      ...base,
      warnings: [
        `MCP server route "${route}" is already used by a content page; the MCP server was not generated. Set a different "mcp.route" in blume.config.ts.`,
      ],
    };
  }
  return {
    ...base,
    discoveryPages: [
      {
        entrypoint: join(dir, "discovery.ts"),
        pattern: "/.well-known/mcp.json",
      },
      {
        entrypoint: join(dir, "server-card.ts"),
        pattern: "/.well-known/mcp/server-card.json",
      },
    ],
    enabled: true,
  };
};

/** Write the MCP data snapshot, server endpoint, and discovery documents. */
const writeMcpFiles = async (
  project: BlumeProject,
  plan: McpPlan,
  write: (path: string, content: string) => Promise<boolean>
): Promise<void> => {
  if (!plan.enabled) {
    return;
  }
  const data = await buildMcpData(project);
  const discoveryInput = {
    name: data.name,
    route: plan.route,
    site: data.site,
    version: data.version,
  };
  await Promise.all([
    write(
      join(plan.srcDir, "generated", "mcp-data.json"),
      `${JSON.stringify(data)}\n`
    ),
    write(
      join(plan.srcDir, "pages", mcpPageFile(plan.route)),
      mcpEndpointTemplate(plan.route)
    ),
    write(
      join(plan.dir, "discovery.ts"),
      staticJsonEndpointTemplate(buildMcpDiscovery(discoveryInput))
    ),
    write(
      join(plan.dir, "server-card.ts"),
      staticJsonEndpointTemplate(buildMcpServerCard(discoveryInput))
    ),
  ]);
};

export interface GenerateResult {
  /** Whether any structural file changed (config/page/content config). */
  structuralChange: boolean;
  /** Non-fatal warnings raised while generating (e.g. a missing API spec). */
  warnings: string[];
}

/**
 * Write (or update) the generated `.blume/` Astro runtime for a project.
 * Only files whose content changed are rewritten so Vite HMR stays fast.
 */
export const generateRuntime = async (
  project: BlumeProject
): Promise<GenerateResult> => {
  const { context, config } = project;
  const out = context.outDir;
  const srcDir = join(out, "src");
  const dataPath = join(srcDir, "generated", "data.json");
  const themePath = join(srcDir, "generated", "app.css");
  const searchClientPath = join(srcDir, "generated", "search-client.ts");

  // Record every file this pass writes so orphans (from a now-disabled feature)
  // can be pruned afterwards. `write` wraps the atomic writer and tracks paths.
  const written = new Set<string>();
  const write = (path: string, content: string): Promise<boolean> => {
    written.add(normalize(path));
    return writeIfChanged(path, content);
  };

  await ensureDepsLink(out);

  const askEnabled = config.ai.ask?.enabled ?? false;
  const exportPdf = config.export.pdf;
  const exportEpub = config.export.epub;
  const [pages, detectedReact, userTheme, islandDiscovery] = await Promise.all([
    context.pagesRoot ? discoverPages(context.pagesRoot) : Promise.resolve([]),
    detectNeedsReact(context.root),
    readOptional(context.themeFile),
    discoverIslands(context.root),
  ]);
  // Each island's framework enables its Astro renderer. React also switches on
  // for any project `.tsx`/`.jsx` and for Ask AI; Vue/Svelte are island-driven.
  const islandFrameworks = new Set(
    islandDiscovery.islands.map((island) => island.framework)
  );
  const needsReact =
    detectedReact || askEnabled || islandFrameworks.has("react");
  const needsVue = islandFrameworks.has("vue");
  const needsSvelte = islandFrameworks.has("svelte");

  // The hosted MCP server. The `.well-known` discovery docs are injected as
  // prerendered routes alongside user pages; the server endpoint itself is a
  // normal (server-rendered) page written by `writeMcpFiles`.
  const mcp = planMcp(project, srcDir);
  pages.push(...mcp.discoveryPages);

  // Staged (non-filesystem) sources materialize into `.blume/content`; keyed by
  // entryId so i18n duplicates of one entry write a single file.
  const staged = collectStaged(project);
  const hasStaged = staged.size > 0;

  const structural = await Promise.all([
    write(
      join(out, "astro.config.mjs"),
      astroConfigTemplate({
        config,
        contentRoutes: project.manifest.routes.map((route) => route.path),
        context,
        dataPath,
        needsReact,
        needsSvelte,
        needsVue,
        pages,
        searchClientPath,
        themePath,
      })
    ),
    write(
      join(out, "package.json"),
      runtimePackageTemplate(
        runtimeDependencies({ config, needsReact, needsSvelte, needsVue })
      )
    ),
    write(join(out, "tsconfig.json"), runtimeTsconfigTemplate()),
    write(join(srcDir, "env.d.ts"), envTemplate()),
    write(
      join(srcDir, "content.config.ts"),
      contentConfigTemplate({ config, context, staged: hasStaged })
    ),
    write(
      join(srcDir, "pages", "[...slug].astro"),
      catchAllPageTemplate({
        askEnabled,
        exportEpub,
        exportPdf,
        mathEnabled: config.markdown.math,
      })
    ),
    write(
      join(srcDir, "generated", "components.ts"),
      userComponentsTemplate(context.componentsFile)
    ),
    write(
      join(srcDir, "generated", "islands.ts"),
      islandMapTemplate(islandDiscovery.islands)
    ),
    write(
      themePath,
      tailwindEntryTemplate({
        configTokens: `${buildThemeCss(config.theme)}${buildFontsCss(config.theme.fonts)}`,
        sources: [
          `${BLUME_SRC}/**/*.{astro,ts,tsx}`,
          `${context.root}/**/*.{astro,mdx,ts,tsx}`,
        ],
        twoslashCss: twoslashCss(),
        userTheme,
      })
    ),
  ]);

  // Per-island hydration wrappers for the `islands/` convention. The map module
  // (written above, always) imports these; orphans from removed islands are
  // pruned at the end of the pass.
  await Promise.all(
    islandDiscovery.islands.map((island) =>
      write(
        join(srcDir, "generated", "islands", `${island.name}.astro`),
        islandWrapperTemplate(island)
      )
    )
  );

  if (askEnabled) {
    await write(
      join(srcDir, "pages", "api", "ask.ts"),
      askEndpointTemplate(resolveAskBackend(config.ai.ask))
    );
  }

  await writeMcpFiles(project, mcp, write);

  if (config.seo.og.enabled) {
    await write(
      join(srcDir, "pages", "og", "[...slug].png.ts"),
      ogEndpointTemplate()
    );
  }

  // Changelog index (`/changelog`): a timeline of every `type: changelog` entry,
  // rendered through the Update layout. Skipped when there are no entries, or
  // when a user content page already occupies the `/changelog` route.
  const hasChangelog = project.graph.pages.some(
    (page) =>
      page.contentType === "changelog" &&
      !(page.meta.draft || page.meta.sidebar.hidden)
  );
  const changelogRouteTaken = project.graph.pages.some(
    (page) => page.route === "/changelog"
  );
  if (hasChangelog && !changelogRouteTaken) {
    await write(
      join(srcDir, "pages", "changelog.astro"),
      changelogIndexTemplate({ askEnabled, exportEpub, exportPdf })
    );
  }

  // The provider-specific client loader behind the `blume:search-client` alias
  // is always (re)generated so the alias resolves even when search is disabled.
  await write(searchClientPath, searchClientTemplate(config));

  // Client-loaded providers (orama, flexsearch) ship a static index + endpoint.
  if (servesStaticIndex(config.search.provider)) {
    const documents = await buildSearchDocuments(project);
    await write(
      join(srcDir, "generated", "search.json"),
      `${JSON.stringify(documents)}\n`
    );
    await write(
      join(srcDir, "pages", "blume-search.json.ts"),
      searchEndpointTemplate()
    );
  }

  // Mixedbread proxies queries through a server endpoint that holds the key.
  if (config.search.provider === "mixedbread") {
    await write(
      join(srcDir, "pages", "api", "search.ts"),
      mixedbreadSearchEndpointTemplate(config.search.mixedbread?.storeId ?? "")
    );
  }

  const rawMarkdown = await buildRawMarkdown(project);
  await Promise.all([
    write(
      join(srcDir, "generated", "raw-markdown.json"),
      `${JSON.stringify(rawMarkdown)}\n`
    ),
    write(
      join(srcDir, "pages", "[...slug].md.ts"),
      rawMarkdownEndpointTemplate()
    ),
    write(
      join(srcDir, "pages", "[...slug].mdx.ts"),
      rawMarkdownEndpointTemplate()
    ),
  ]);

  // Automatic RSS feeds for blog/changelog content types (a no-op when no such
  // pages exist or no deployment.site is configured).
  const feeds = buildRssFeeds(project);
  if (feeds.length > 0) {
    const feedXml = Object.fromEntries(
      feeds.map((feed) => [feed.type, renderRssFeed(feed)])
    );
    await Promise.all([
      write(
        join(srcDir, "generated", "rss.json"),
        `${JSON.stringify(feedXml)}\n`
      ),
      write(
        join(srcDir, "pages", "[section]", "rss.xml.ts"),
        rssEndpointTemplate()
      ),
    ]);
  }

  // API/AsyncAPI reference pages (Scalar). One self-contained page per source,
  // mounted on its configured route and regenerated each run.
  const warnings: string[] = [...mcp.warnings, ...islandDiscovery.warnings];

  // The new provider SDKs are optional peers; warn (rather than fail opaquely in
  // Vite) when the configured provider's package isn't installed.
  for (const dep of searchProviderMeta(config.search.provider).runtimeDeps) {
    if (!canResolveFrom(context.root, dep)) {
      warnings.push(
        `Search provider "${config.search.provider}" needs "${dep}", which isn't installed. Run \`npm install ${dep}\` (or your package manager's equivalent).`
      );
    }
  }

  // React ships with Blume; Vue/Svelte islands need their Astro integration
  // installed by the project. Warn early rather than let Vite fail to resolve it.
  warnings.push(...islandFrameworkWarnings(islandFrameworks, context.root));
  if (hasReferences(config)) {
    const references = await buildReferenceFiles({
      config,
      contentRoutes: new Set(project.graph.pages.map((page) => page.route)),
      root: context.root,
    });
    warnings.push(...references.warnings);
    await Promise.all(
      references.files.map((file) =>
        write(join(srcDir, "pages", file.pagePath), file.content)
      )
    );
  }

  // Data and manifest are not "structural" for Astro; they hot-reload.
  await write(
    join(srcDir, "generated", "data.json"),
    buildRuntimeData(project)
  );
  await write(
    join(out, "blume.manifest.json"),
    `${JSON.stringify(project.manifest, null, 2)}\n`
  );

  // Write staged source bodies and prune orphans under `.blume/content` (its own
  // tree, outside `.blume/src`), so a removed remote entry doesn't linger.
  await writeStagedContent(out, staged);

  // Remove anything under `.blume/src` this pass didn't write — e.g. an Ask AI
  // endpoint left behind after the feature was switched off.
  await pruneOrphans(srcDir, written);

  return { structuralChange: structural.some(Boolean), warnings };
};

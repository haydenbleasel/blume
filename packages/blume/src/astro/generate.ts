import { existsSync, readFileSync, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { basename, dirname, join, normalize, relative } from "pathe";
import { glob } from "tinyglobby";

import { buildAskData } from "../ai/ask-data.ts";
import { resolveAskBackend } from "../ai/ask.ts";
import { buildRawMarkdown } from "../ai/markdown.ts";
import { buildMcpData } from "../ai/mcp/data.ts";
import { buildMcpDiscovery, buildMcpServerCard } from "../ai/mcp/discovery.ts";
import { validateUsedComponents } from "../core/component-diagnostics.ts";
import { analyzeComponentOverrides } from "../core/component-overrides.ts";
import type {
  BlumeBanner,
  BlumeData,
  BlumeFavicon,
  BlumeLogo,
} from "../core/data.ts";
import { EN_UI, resolveUIStrings } from "../core/i18n-ui.ts";
import { resolveFallbackLocale } from "../core/i18n.ts";
import { validateNavTargets } from "../core/nav-diagnostics.ts";
import { packageRoot } from "../core/package-root.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import { resolveDocsCollection } from "../core/sources/resolve.ts";
import { resolveTsconfigAliases } from "../core/tsconfig-aliases.ts";
import type { Navigation } from "../core/types.ts";
import { buildRssFeeds, renderRssFeed } from "../deploy/rss.ts";
import { resolveOgLogo } from "../og/logo.ts";
import { hasScalarReferences, referenceRoutes } from "../openapi/references.ts";
import { buildReferenceFiles } from "../openapi/scalar.ts";
import { isOpenApiSource } from "../openapi/source.ts";
import { registry } from "../registry/registry.ts";
import { buildSearchDocuments } from "../search/documents.ts";
import { searchProviderMeta, servesStaticIndex } from "../search/providers.ts";
import {
  examplesEntryTemplate,
  tailwindEntryTemplate,
} from "../theme/entry.ts";
import { buildFontsCss, configuredCssVars } from "../theme/fonts.ts";
import { buildThemeCss } from "../theme/palette.ts";
import { twoslashCss } from "../theme/twoslash.ts";
import { planComponentSlots } from "./component-slots.ts";
import type { ComponentSlotPlan } from "./component-slots.ts";
import { discoverExamples } from "./examples.ts";
import { discoverIslands } from "./islands.ts";
import {
  customOgRoutes,
  discoverPages,
  hasGeneratedChangelog,
  routeIsTaken,
} from "./pages.ts";
import {
  askComponentTemplate,
  askEndpointTemplate,
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
  staticJsonEndpointTemplate,
  runtimeDependencies,
  runtimePackageTemplate,
  runtimeTsconfigTemplate,
  searchClientTemplate,
  searchEndpointTemplate,
  stagedContentDir,
} from "./templates.ts";

/** Absolute path to the Blume package `src` directory. */
const BLUME_SRC = join(packageRoot(), "src");

/** Whether a module specifier resolves from a directory via node resolution. */
const canResolveFrom = (fromDir: string, spec: string): boolean => {
  try {
    createRequire(pathToFileURL(join(fromDir, "_.js")).href).resolve(spec);
    return true;
  } catch {
    return false;
  }
};

/**
 * Absolute path to `babel-plugin-react-compiler`, resolved from Blume's own
 * package root (Blume ships it). Returns null when React or the compiler is off.
 *
 * The path must be absolute: @vitejs/plugin-react resolves babel plugins from
 * the *project* root, not `.blume/`, so a bare specifier fails in a user project
 * that never installed the plugin directly. Resolving from `packageRoot()` binds
 * to Blume's shipped copy regardless of the user's package manager or hoisting.
 */
const resolveReactCompiler = (
  config: ResolvedConfig,
  needsReact: boolean
): string | null => {
  if (!(needsReact && config.react.compiler)) {
    return null;
  }
  try {
    return createRequire(
      pathToFileURL(join(packageRoot(), "_.js")).href
    ).resolve("babel-plugin-react-compiler");
  } catch {
    return null;
  }
};

/**
 * Warning (as a spreadable list) for the case where the React Compiler was
 * requested but its plugin couldn't be resolved — so the build silently drops
 * to uncompiled output rather than failing.
 */
const reactCompilerWarnings = (
  config: ResolvedConfig,
  needsReact: boolean,
  compilerPath: string | null
): string[] =>
  needsReact && config.react.compiler && !compilerPath
    ? [
        "React Compiler is enabled but `babel-plugin-react-compiler` could not be resolved; falling back to an uncompiled build. Reinstall Blume, or set `react: { compiler: false }` to silence this.",
      ]
    : [];

/**
 * Realpath of the `astro` package node resolves from a directory, or null when
 * none resolves. Comparing this for `.blume/` against Blume's own deps tells
 * whether the runtime would bind to the *same* astro Blume uses or a different
 * one shadowing it (the hoisted-conflict failure mode).
 */
const resolvedAstroPath = (fromDir: string): string | null => {
  try {
    const pkg = createRequire(
      pathToFileURL(join(fromDir, "_.js")).href
    ).resolve("astro/package.json");
    return realpathSync(pkg);
  } catch {
    return null;
  }
};

/**
 * Locate the directory that holds Blume's installed dependencies (Astro and its
 * integrations).
 *
 * With a clean hoisted install this is moot — the deps sit in a `node_modules`
 * the generated `.blume/` already walks up into, and {@link ensureDepsLink}
 * short-circuits before we need it. But under isolated linkers (Bun's
 * `isolated` mode, pnpm) Blume's deps are NOT hoisted into the project; they
 * live beside the Blume package in a virtual store, invisible to the upward
 * walk from `.blume/`. Two layouts are possible, so probe for `astro`:
 *   - `<blume>/node_modules` — deps nested under the package (workspace source)
 *   - `dirname(<blume>)`     — deps as siblings in the store (isolated/pnpm)
 *
 * `packageRoot()` resolves to Blume's real on-disk path (Node follows the
 * install symlink), so its parent is the store's package directory where the
 * isolated linker places the siblings. The previous fixed
 * `packageRoot()/node_modules` assumption missed the sibling layout entirely,
 * which is why isolated-linker projects had to redeclare Blume's deps by hand.
 */
export const blumeDepsDir = (pkgDir: string = packageRoot()): string | null => {
  const candidates = [join(pkgDir, "node_modules"), dirname(pkgDir)];
  return candidates.find((dir) => existsSync(join(dir, "astro"))) ?? null;
};

/**
 * Point `link` at Blume's dependency directory via a `node_modules` junction,
 * replacing a stale junction we own and leaving a real directory untouched.
 *
 * `lstat`, not `existsSync`, so a broken junction (target since moved) is still
 * detected — `existsSync` follows the link and reports a dangling one as absent.
 */
const linkDepsJunction = async (
  link: string,
  depsDir: string
): Promise<void> => {
  let existing: Awaited<ReturnType<typeof lstat>> | null;
  try {
    existing = await lstat(link);
  } catch {
    existing = null;
  }
  if (existing) {
    if (!existing.isSymbolicLink()) {
      return;
    }
    await rm(link, { force: true });
  }
  await mkdir(dirname(link), { recursive: true });
  await symlink(depsDir, link, "junction");
};

/** Read the `version` field of a `package.json`, or null when unreadable. */
const readPkgVersion = (pkgJsonPath: string | null): string | null => {
  if (!pkgJsonPath) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(pkgJsonPath, "utf-8")).version ?? null;
  } catch {
    return null;
  }
};

/**
 * Build the diagnostic for a split-layout Astro conflict that a symlink can't
 * repair: a different Astro is hoisted to the project root, shadowing Blume's,
 * and `@astrojs/mdx` binds to the wrong copy. `blumeAstroPkg`/`shadowAstroPkg`
 * are the resolved `astro/package.json` paths for Blume's set and the one the
 * runtime actually resolves.
 */
const astroConflictWarning = (
  blumeAstroPkg: string | null,
  shadowAstroPkg: string | null
): string => {
  const blume = readPkgVersion(blumeAstroPkg);
  const shadow = readPkgVersion(shadowAstroPkg);
  const versions =
    blume && shadow
      ? `astro@${shadow} shadowing Blume's astro@${blume}`
      : "a second copy of Astro shadowing Blume's";
  const pin = blume ?? "<Blume's astro version>";
  return `Astro version conflict: another dependency hoisted ${versions} to the project root, so @astrojs/mdx binds to the wrong copy and the build fails on a missing export (e.g. "chunkToString"). A single symlink can't reconcile a split install — pin Blume's Astro by adding a package.json "overrides" (npm/bun/pnpm) or "resolutions" (yarn) entry { "astro": "${pin}" }, then reinstall. Run \`npm ls astro\` to find the dependency pulling the older copy.`;
};

/**
 * Make the generated runtime resolve Astro and its integrations against Blume's
 * own dependency set. Two failure modes this repairs:
 *
 *   - Astro is *unreachable* from `.blume/` (workspaces under isolated linkers,
 *     pnpm) — the deps live in a store the upward walk can't see.
 *   - Astro *resolves to the wrong copy* — a hoisted sibling pinned an older
 *     major (e.g. `astro@6` for a type-only import) that shadows Blume's
 *     `astro@7`, so `@astrojs/mdx@7` binds to it and crashes the build on a
 *     missing export. Resolving merely *an* astro isn't enough; it must be the
 *     same one Blume uses.
 *
 * In both cases we symlink Blume's dependency directory in as
 * `.blume/node_modules` so the generated config's bare specifiers (`astro`,
 * `@astrojs/mdx`, …) bind to the matching set. We only do this when those deps
 * are a *co-located, consistent* set (astro beside the `@astrojs/mdx` that binds
 * to it). A split layout — an integration hoisted away from a conflicting astro
 * — can't be made consistent by a single symlink and needs a root `overrides`/
 * `resolutions` pin instead. We can't fix that from `.blume/`, so we return a
 * diagnostic naming the conflict rather than silently shipping a runtime that
 * crashes downstream. Returns the warning, or null when nothing needs saying.
 */
export const ensureDepsLink = async (
  outDir: string,
  pkgDir: string = packageRoot()
): Promise<string | null> => {
  const depsDir = blumeDepsDir(pkgDir);
  if (!depsDir) {
    return null;
  }
  // Already correct when `.blume/` resolves the very same astro Blume's deps
  // provide — the clean hoisted case, nothing to do.
  const blumeAstro = resolvedAstroPath(depsDir);
  const outDirAstro = resolvedAstroPath(outDir);
  if (blumeAstro && outDirAstro === blumeAstro) {
    return null;
  }
  // A co-located, consistent set (astro beside the @astrojs/mdx that binds to
  // it) can be linked in wholesale; this repairs the unreachable and the
  // repairable-conflict cases. Any existing link here is stale and gets
  // replaced.
  if (existsSync(join(depsDir, "@astrojs", "mdx"))) {
    await linkDepsJunction(join(outDir, "node_modules"), depsDir);
    return null;
  }
  // Split layout: Blume's astro is nested (a conflicting astro took the root
  // spot) but @astrojs/mdx hoisted away from it, binding to the shadow. Only a
  // root pin fixes this — surface it.
  return astroConflictWarning(blumeAstro, outDirAstro);
};

/**
 * Vite plugin that makes Blume's externalized runtime deps (zod, shiki, sharp,
 * `takumi-js`, …) resolvable when Astro executes the static prerender
 * bundle under an isolated linker (Bun's `isolated` mode, pnpm).
 *
 * Astro's static build emits a self-contained SSR bundle to
 * `<outDir>/.prerender/` and `import()`s it in-process to generate the HTML.
 * That bundle externalizes Blume's render-time deps, so Node resolves them at
 * prerender time by walking up from `.prerender/chunks/*.mjs`. {@link
 * ensureDepsLink} only repairs resolution rooted at `.blume/`; `.prerender/`
 * lives under `dist/`, a separate tree an isolated linker never hoists Blume's
 * deps into — so the import dies with `Cannot find package 'zod'`. We drop the
 * same `node_modules` junction into the prerender root, mirroring
 * `.blume/node_modules`, so every externalized specifier — native bindings
 * included, which can't be bundled — resolves. Astro deletes `.prerender/` once
 * generation finishes (and the junction with it: `fs.rm` unlinks symlinks, it
 * never follows them), so nothing leaks into the published `dist/`.
 *
 * Keyed off the output dir's basename (`.prerender`) — the name Astro 7 gives
 * the prerender build for both static (`<outDir>/.prerender/`) and server
 * (`<build.server>/.prerender/`) output — so it fires for exactly that build.
 * Inert in dev, where there is no build and `writeBundle` never runs.
 */
export const prerenderDepsPlugin = (
  pkgDir: string = packageRoot()
): {
  name: string;
  writeBundle: (options: { dir?: string }) => Promise<void>;
} => ({
  name: "blume:prerender-deps",
  writeBundle: async (options) => {
    if (!options.dir || basename(options.dir) !== ".prerender") {
      return;
    }
    const depsDir = blumeDepsDir(pkgDir);
    if (!depsDir) {
      return;
    }
    await linkDepsJunction(join(options.dir, "node_modules"), depsDir);
  },
});

/** The subset of Rollup's plugin context `blume:server-app-resolve` needs. */
interface ServerAppResolveContext {
  resolve: (source: string) => Promise<{ id: string } | null>;
}

/**
 * Work around an Astro + Vite dev bug that breaks content renames.
 *
 * Astro's dev SSR entry is the virtual module `astro:server-app`, but its
 * resolver only matches the exact id (`/^astro:server-app$/`). Whenever the
 * route set changes — a content add, remove, or rename — Astro triggers a full
 * page reload, during which Vite re-requests the entry as `astro:server-app.js`.
 * The trailing `.js` misses Astro's filter, so the load fails ("Failed to load
 * url astro:server-app.js") and Vite's SSR module runner is left corrupted: the
 * in-memory content store never reconnects, so `getEntry` returns undefined and
 * the renamed page 404s until the dev server is manually restarted.
 *
 * Stripping the spurious `.js` and delegating back to Astro's resolver lets the
 * reload complete cleanly, so the renamed route resolves without a restart.
 */
export const serverAppResolvePlugin = (): {
  enforce: "pre";
  name: string;
  resolveId: (
    this: ServerAppResolveContext,
    id: string
  ) => Promise<string | null>;
} => ({
  enforce: "pre",
  name: "blume:server-app-resolve",
  async resolveId(id) {
    if (id === "astro:server-app.js") {
      const resolved = await this.resolve("astro:server-app");
      return resolved?.id ?? null;
    }
    return null;
  },
});

/** Astro integration package each non-React island framework needs installed. */
const ISLAND_FRAMEWORK_DEPS: Record<string, string> = {
  svelte: "@astrojs/svelte",
  vue: "@astrojs/vue",
};

/**
 * Adapter package the project must install itself for each deployment
 * platform whose adapter Blume doesn't ship. Node and Vercel ship with Blume,
 * so they never need this.
 */
const DEPLOYMENT_ADAPTER_DEPS: Record<string, string> = {
  cloudflare: "@astrojs/cloudflare",
  netlify: "@astrojs/netlify",
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

/**
 * Warn when the resolved server-output adapter is one the project must install
 * itself (Netlify/Cloudflare; Node and Vercel ship with Blume). The generated
 * astro.config.mjs imports the adapter package directly — and on those
 * platforms the adapter is even auto-selected from env vars — so warn early
 * rather than let the build die with an opaque ERR_MODULE_NOT_FOUND from the
 * hidden generated config. Availability mirrors the search-provider check: a
 * dep resolves from the project root or from the Blume package itself.
 */
const deploymentAdapterWarnings = (
  deployment: ResolvedConfig["deployment"],
  root: string
): string[] => {
  const dep =
    deployment.output === "server" && deployment.adapter
      ? DEPLOYMENT_ADAPTER_DEPS[deployment.adapter]
      : undefined;
  if (
    dep &&
    !(canResolveFrom(root, dep) || canResolveFrom(packageRoot(), dep))
  ) {
    return [
      `Deployment adapter "${deployment.adapter}" needs "${dep}", which isn't installed. Run \`npm install ${dep}\` (or your package manager's equivalent).`,
    ];
  }
  return [];
};

/** Absolute path to the configured `examples.css`, or null when unset. */
const examplesCssFile = (root: string, config: ResolvedConfig): string | null =>
  config.examples.css ? join(root, config.examples.css) : null;

/**
 * Write the per-example preview route (`{basePath}/blume-examples/<path>`)
 * that `<Component />` iframes embed — the iframe boundary is what isolates
 * previews from the docs CSS. Nested under `basePath` in the filesystem so
 * the routes stay reachable behind a proxy that only forwards the base;
 * pruneOrphans clears a stale copy when `basePath` changes or the last
 * example is removed. Returns (as a spreadable list) a warning when the
 * configured `examples.css` doesn't exist.
 */
const writeExamplesPreview = async (options: {
  config: ResolvedConfig;
  hasExamples: boolean;
  root: string;
  srcDir: string;
  write: (path: string, content: string) => Promise<boolean>;
}): Promise<string[]> => {
  const { config, hasExamples, root, srcDir, write } = options;
  if (hasExamples) {
    await write(
      join(
        srcDir,
        "pages",
        ...config.basePath.split("/").filter(Boolean),
        "blume-examples",
        "[...path].astro"
      ),
      examplesPageTemplate()
    );
  }
  const cssFile = examplesCssFile(root, config);
  return cssFile && !existsSync(cssFile)
    ? [
        `examples.css points at "${config.examples.css}", which doesn't exist; previews render without it.`,
      ]
    : [];
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

/** Block math (`$$…$$`) or an explicitly authored `<Math …>` component. */
const containsMath = (content: string): boolean =>
  content.includes("$$") || content.includes("<Math");

/**
 * Detect whether the project can render math: block math (`$$…$$`) or an
 * explicit `<Math>` tag in any local `.md`/`.mdx`, or in staged (non-filesystem)
 * source bodies. Drives whether the generated runtime imports the `<Math>`
 * component and KaTeX's stylesheet, so a math-free site ships no KaTeX CSS.
 * Math parsing itself is always on but block-only, so one of those literals is
 * a necessary condition — no false negatives. A stray `$$` (e.g. inside a code
 * fence) merely over-includes the idempotent import, which is harmless.
 */
export const detectUsesMath = async (
  root: string,
  staged: Iterable<string> = []
): Promise<boolean> => {
  const files = await glob(["**/*.{md,mdx}"], {
    cwd: root,
    ignore: ["**/node_modules/**", "**/.blume/**", "**/dist/**"],
    onlyFiles: true,
  });
  const contents = await Promise.all(
    files.map((file) => readOptional(join(root, file)))
  );
  return [...contents, ...staged].some(containsMath);
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
  const removals: Promise<void>[] = [];
  for (const path of existing) {
    const normalized = normalize(path);
    if (!written.has(normalized)) {
      removals.push(rm(normalized, { force: true }));
    }
  }
  await Promise.all(removals);
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

interface LogoDimensions {
  height: number;
  width: number;
}

const SVG_ROOT = /<svg\b(?<attributes>[^>]*)>/u;
const SVG_WIDTH = /\bwidth\s*=\s*["'](?<value>[^"']+)["']/u;
const SVG_HEIGHT = /\bheight\s*=\s*["'](?<value>[^"']+)["']/u;
const SVG_LENGTH = /^\s*(?<value>[\d.]+)(?:px)?\s*$/u;
const SVG_VIEW_BOX =
  /\bviewBox\s*=\s*["'][\d.-]+[\s,]+[\d.-]+[\s,]+(?<width>[\d.]+)[\s,]+(?<height>[\d.]+)["']/u;

const parseSvgLength = (value: string | undefined): number | undefined => {
  const length = Number(value?.match(SVG_LENGTH)?.groups?.value);
  return length > 0 ? length : undefined;
};

/** Read dimensions from an SVG's explicit size or its view box. */
const svgDimensions = (svg: string | undefined): LogoDimensions | undefined => {
  const attributes = svg?.match(SVG_ROOT)?.groups?.attributes;
  const width = parseSvgLength(attributes?.match(SVG_WIDTH)?.groups?.value);
  const height = parseSvgLength(attributes?.match(SVG_HEIGHT)?.groups?.value);
  if (width && height) {
    return { height, width };
  }

  const viewBox = attributes?.match(SVG_VIEW_BOX);
  const viewBoxWidth = Number(viewBox?.groups?.width);
  const viewBoxHeight = Number(viewBox?.groups?.height);
  return viewBoxWidth > 0 && viewBoxHeight > 0
    ? { height: viewBoxHeight, width: viewBoxWidth }
    : undefined;
};

/** Read a local SVG logo from the project root or public directory. */
const readLogoSvg = (
  project: BlumeProject,
  source: string | undefined
): string | undefined => {
  if (!source?.toLowerCase().endsWith(".svg")) {
    return;
  }
  const rel = source.replace(/^\//u, "");
  const file = [
    join(project.context.root, "public", rel),
    join(project.context.root, rel),
  ].find((path) => existsSync(path));
  return file ? readFileSync(file, "utf-8") : undefined;
};

/**
 * Resolve the configured logo. A single SVG is read and inlined so a
 * `currentColor` logo follows the theme; other images keep their URL for an
 * `<img>`. The file is looked up under `public/` and the project root.
 */
const resolveLogo = (project: BlumeProject): BlumeLogo | null => {
  const { logo } = project.config;
  if (!logo) {
    return null;
  }
  const config = typeof logo === "string" ? { image: logo } : logo;
  // `text` is passed through verbatim: `undefined` lets the brand fall back to
  // the site title, `""` renders the mark alone (a logo with the wordmark baked
  // in).
  const { href, image: source, text } = config;
  const image = typeof source === "string" ? { light: source } : source;
  const light = image?.light ?? image?.dark;
  const dark = image?.dark ?? image?.light;
  const alt = image?.alt ?? "";
  const brandHref = href ?? "/";
  const lightSvg = readLogoSvg(project, light);
  const darkSvg = dark === light ? lightSvg : readLogoSvg(project, dark);

  if (light && light === dark && lightSvg) {
    return { alt, href: brandHref, svg: lightSvg, text };
  }

  const lightDimensions = svgDimensions(lightSvg);
  const darkDimensions = svgDimensions(darkSvg);
  const dimensions =
    lightDimensions || darkDimensions
      ? { dark: darkDimensions, light: lightDimensions }
      : undefined;
  return { alt, dark, dimensions, href: brandHref, light, text };
};

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
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
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
const defaultFavicon = (): BlumeFavicon => ({
  href: inlineDataUri(join(BLUME_SRC, "assets", "icon.png"), "image/png"),
  type: "image/png",
});

/**
 * Apple touch icon filenames Blume auto-detects, in priority order. Mirrors the
 * Next.js `apple-icon.*` convention (plus the `apple-touch-icon.png` most favicon
 * generators emit): a match in `public/` or the project root becomes the iOS
 * home-screen icon, no config required.
 */
const APPLE_ICON_CANDIDATES = [
  "apple-icon.png",
  "apple-icon.jpg",
  "apple-icon.jpeg",
  "apple-touch-icon.png",
];

/**
 * Resolve an icon file by convention. A candidate in `public/` is served as-is
 * and referenced by URL; one at the project root is inlined as a data URI (the
 * root isn't a served directory). Returns null when the project ships none.
 */
const resolveIconFile = (
  project: BlumeProject,
  candidates: string[]
): BlumeFavicon | null => {
  const { root } = project.context;
  for (const name of candidates) {
    if (existsSync(join(root, "public", name))) {
      return { href: `/${name}`, type: faviconType(name) };
    }
  }
  for (const name of candidates) {
    const file = join(root, name);
    if (existsSync(file)) {
      const type = faviconType(name);
      return { href: inlineDataUri(file, type ?? "image/x-icon"), type };
    }
  }
  return null;
};

/**
 * Resolve the site favicon by convention, falling back to the bundled Blume mark
 * when the project ships no `icon.*`/`favicon.*` file.
 */
const resolveFavicon = (project: BlumeProject): BlumeFavicon =>
  resolveIconFile(project, FAVICON_CANDIDATES) ?? defaultFavicon();

/**
 * Resolve the Apple touch icon by convention, or null when the project ships
 * none (unlike the favicon, there's no bundled default). Note: iOS ignores
 * `data:`-URI apple-touch-icons, so a `public/` file (served by URL) is the
 * reliable path; a root-level file is still inlined for symmetry with favicons.
 */
const resolveAppleIcon = (project: BlumeProject): BlumeFavicon | null =>
  resolveIconFile(project, APPLE_ICON_CANDIDATES);

/** Normalize the banner config (string shorthand or object) for the runtime. */
const resolveBanner = (config: ResolvedConfig): BlumeBanner | null => {
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
  const logo = resolveLogo(project);
  const ogLogo = config.seo.og.logo
    ? resolveOgLogo(project, config.seo.og.logo)
    : logo?.svg;

  const editUrlFor = (sourcePath?: string): string | null => {
    if (!(editBase && sourcePath)) {
      return null;
    }
    const rel = relative(context.root, sourcePath).split("\\").join("/");
    const editPath = github?.dir ? `${github.dir}/${rel}` : rel;
    return `${editBase}/${editPath}`;
  };

  const { i18n } = config;

  // Resolve the header repo link per locale. API references no longer add a tab
  // automatically — authors point a `navigation.tabs` entry at the reference
  // route to surface it (see `referenceRoutes`).
  const withRepoUrl = (nav: Navigation): Navigation => ({
    ...nav,
    repoUrl: config.navigation.repo && repoUrl ? repoUrl : null,
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
          withRepoUrl(
            graph.navigationByLocale[code] ?? {
              featured: [],
              selectors: [],
              sidebar: [],
              tabs: [],
            }
          ),
        ])
      )
    : {};

  const data: BlumeData = {
    config: {
      analytics: config.analytics ?? null,
      appleIcon: resolveAppleIcon(project),
      ask: config.ai.ask?.enabled
        ? { suggestions: config.ai.ask.suggestions }
        : null,
      banner: resolveBanner(config),
      basePath: config.basePath,
      codeThemes: config.markdown.codeBlocks.theme,
      codeWrap: config.markdown.code.wrap,
      description: config.description,
      favicon: resolveFavicon(project),
      feedback: config.feedback,
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
      logo,
      mcp: config.ai.mcp.enabled
        ? {
            name: config.ai.mcp.name ?? config.title,
            route: config.ai.mcp.route,
          }
        : null,
      // `og.enabled` is resolved to a definite boolean in `loadConfig`; coerce
      // the optional schema type so the serialized shape stays `boolean`.
      og: {
        enabled: config.seo.og.enabled ?? false,
        logo: ogLogo,
        palette: config.seo.og.palette,
      },
      repoUrl,
      search: {
        enabled: config.search.provider !== "none",
        provider: config.search.provider,
      },
      site: config.deployment.site ?? null,
      structuredData: config.seo.structuredData,
      theme: config.theme,
      title: config.title,
      toc: config.toc,
      x: config.seo.x,
    },
    feeds: buildRssFeeds(project).map((feed) => ({
      href: feed.path,
      title: feed.title,
    })),
    // CSS variables for Astro's <Font> component; matches the astro.config
    // `fonts:` entries derived from the same theme.fonts config.
    fontCssVars: configuredCssVars(config.theme.fonts),
    navigation: withRepoUrl(graph.navigation),
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
 * warning — when a content page or a custom `.astro` page already occupies its
 * route, so the user's page keeps working instead of colliding.
 */
const planMcp = (
  project: BlumeProject,
  srcDir: string,
  userPages: { pattern: string }[]
): McpPlan => {
  const { config } = project;
  const { route } = config.ai.mcp;
  const dir = join(srcDir, "blume-mcp");
  const base: McpPlan = {
    dir,
    discoveryPages: [],
    enabled: false,
    route,
    srcDir,
    warnings: [],
  };
  if (!config.ai.mcp.enabled) {
    return base;
  }
  if (routeIsTaken(userPages, project.graph.pages, route)) {
    return {
      ...base,
      warnings: [
        `MCP server route "${route}" is already used by a content or custom page; the MCP server was not generated. Set a different "ai.mcp.route" in blume.config.ts.`,
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
    base: data.base,
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

/**
 * Write the Ask AI endpoint and, unless the backend runs its own retrieval
 * (Inkeep), the grounding snapshot the endpoint queries at request time. A no-op
 * when Ask AI is disabled.
 */
const writeAskFiles = async (
  project: BlumeProject,
  srcDir: string,
  write: (path: string, content: string) => Promise<boolean>
): Promise<void> => {
  const { ask } = project.config.ai;
  if (!ask?.enabled) {
    return;
  }
  const grounded = ask.provider !== "inkeep";
  if (grounded) {
    await write(
      join(srcDir, "generated", "ask-data.json"),
      `${JSON.stringify(await buildAskData(project))}\n`
    );
  }
  await write(
    join(srcDir, "pages", "api", "ask.ts"),
    askEndpointTemplate(resolveAskBackend(ask), grounded)
  );
};

/**
 * Write the default 404 page at Astro's reserved `src/pages/404.astro` path so
 * static builds emit `dist/404.html`. Skipped when the project already owns
 * `/404` (a custom `pages/404.astro` or a `404.md` content page), letting it be
 * fully overridden without a route collision; `pruneOrphans` then removes any
 * previously-generated copy.
 */
const writeNotFoundPage = async (
  write: (path: string, content: string) => Promise<boolean>,
  srcDir: string,
  pages: { pattern: string }[],
  contentPages: { route: string }[]
): Promise<void> => {
  if (routeIsTaken(pages, contentPages, "/404")) {
    return;
  }
  await write(join(srcDir, "pages", "404.astro"), notFoundPageTemplate());
};

export interface GenerateResult {
  /** Whether any structural file changed (config/page/content config). */
  structuralChange: boolean;
  /** Non-fatal warnings raised while generating (e.g. a missing API spec). */
  warnings: string[];
}

/**
 * Statically analyze the user's `components.ts` (never executing it) and plan the
 * generated `components.ts` module plus any hydration wrappers. Returns the plan
 * and the analyzer's warnings; a project with no components file gets an empty
 * plan and no warnings.
 */
const buildComponentSlots = async (
  componentsFile: string | null
): Promise<{
  plan: ComponentSlotPlan;
  /** MDX tags the overrides define (for the unknown-component check). */
  tags: string[];
  warnings: string[];
}> => {
  const analysis = componentsFile
    ? analyzeComponentOverrides(
        await readFile(componentsFile, "utf-8"),
        componentsFile
      )
    : null;
  return {
    plan: planComponentSlots(componentsFile, analysis),
    tags: analysis
      ? [...analysis.mdx, ...analysis.islands].map((entry) => entry.key)
      : [],
    warnings: analysis ? analysis.warnings : [],
  };
};

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
  const askPath = join(srcDir, "generated", "Ask.astro");
  const dataPath = join(srcDir, "generated", "data.json");
  const themePath = join(srcDir, "generated", "app.css");
  const searchClientPath = join(srcDir, "generated", "search-client.ts");
  const examplesPath = join(srcDir, "generated", "examples.ts");
  const examplesThemePath = join(srcDir, "generated", "examples.css");
  const openapiPath = join(srcDir, "generated", "openapi.json");

  // Record every file this pass writes so orphans (from a now-disabled feature)
  // can be pruned afterwards. `write` wraps the atomic writer and tracks paths.
  const written = new Set<string>();
  const write = (path: string, content: string): Promise<boolean> => {
    written.add(normalize(path));
    return writeIfChanged(path, content);
  };

  const depsLinkWarning = await ensureDepsLink(out);

  const askEnabled = config.ai.ask?.enabled ?? false;
  const exportPdf = config.export.pdf;
  const exportEpub = config.export.epub;
  // Staged (non-filesystem) sources materialize into `.blume/content`; keyed by
  // entryId so i18n duplicates of one entry write a single file. Collected here
  // so math detection also sees staged bodies (they never live under root).
  const staged = collectStaged(project);
  // Statically analyze `components.ts` overrides (never executed): drives the
  // `islands` group, hydration on layout/mdx overrides, string-path resolution,
  // and the "framework component with no client mode" diagnostic. Independent of
  // the discovery reads, so it joins the same parallel batch.
  const [
    pages,
    detectedReact,
    usesMath,
    userTheme,
    userExamplesCss,
    islandDiscovery,
    exampleDiscovery,
    componentSlots,
  ] = await Promise.all([
    context.pagesRoot ? discoverPages(context.pagesRoot) : Promise.resolve([]),
    detectNeedsReact(context.root),
    detectUsesMath(context.root, staged.values()),
    readOptional(context.themeFile),
    readOptional(examplesCssFile(context.root, config)),
    discoverIslands(context.root),
    discoverExamples(context.root, config.examples.source),
    buildComponentSlots(context.componentsFile),
  ]);
  const {
    plan: slotPlan,
    tags: overrideTags,
    warnings: overrideWarnings,
  } = componentSlots;

  // Each island/example framework enables its Astro renderer. React also
  // switches on for any project `.tsx`/`.jsx` and for Ask AI; Vue/Svelte are
  // island/example-driven. `.astro` examples need no renderer. Component
  // overrides referencing a framework component enable its renderer too.
  const frameworks = new Set<string>([
    ...islandDiscovery.islands.map((island) => island.framework),
    ...exampleDiscovery.examples.map((example) => example.framework),
    ...slotPlan.frameworks,
  ]);
  const needsReact = detectedReact || askEnabled || frameworks.has("react");
  const needsVue = frameworks.has("vue");
  const needsSvelte = frameworks.has("svelte");

  // Absolute path to the React Compiler babel plugin (null when off). Resolved
  // here, Node-side, so the generated config points babel straight at Blume's
  // shipped copy — see resolveReactCompiler. Any unresolved-but-requested
  // warning is folded into `warnings` below (declared later).
  const reactCompilerPath = resolveReactCompiler(config, needsReact);

  // Custom pages that should get a generated OG card (the home most of all).
  // Computed before the MCP `.well-known` routes are appended below — those are
  // private and filtered out anyway, but the intent is the user's pages.
  const ogRoutes = customOgRoutes(pages, config.title);

  // The hosted MCP server. The `.well-known` discovery docs are injected as
  // prerendered routes alongside user pages; the server endpoint itself is a
  // normal (server-rendered) page written by `writeMcpFiles`.
  const mcp = planMcp(project, srcDir, pages);
  pages.push(...mcp.discoveryPages);

  const hasStaged = staged.size > 0;
  // Only emit a project-scanning `docs` collection when a filesystem source
  // actually feeds it. An all-staged project (openapi/notion/…) has only staged
  // sources, so the `docs` glob would otherwise scan (and watch) the whole
  // project root for nothing — see contentConfigTemplate.
  const hasFilesystemSource = project.sources.some((source) => !source.staged);

  // All of these write to distinct generated paths and never read one another's
  // output, so the structural files, the per-convention hydration wrappers, and
  // the Ask/MCP writers all run in one parallel batch. Only the structural
  // writes' change flags feed `structuralChange`, so they stay a nested group.
  const [structural] = await Promise.all([
    Promise.all([
      write(
        join(out, "astro.config.mjs"),
        astroConfigTemplate({
          aliases: resolveTsconfigAliases(context.root),
          askPath,
          config,
          contentRoutes: project.manifest.routes.map((route) => route.path),
          context,
          dataPath,
          examplesPath,
          examplesThemePath,
          needsReact,
          needsSvelte,
          needsVue,
          openapiPath,
          pages,
          reactCompilerPath,
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
        contentConfigTemplate({
          collection: resolveDocsCollection(config, context),
          config,
          context,
          filesystem: hasFilesystemSource,
          staged: hasStaged,
        })
      ),
      write(
        join(srcDir, "pages", "[...slug].astro"),
        catchAllPageTemplate({
          exportEpub,
          exportPdf,
          mathEnabled: usesMath,
          needsReact,
        })
      ),
      // The header's Ask trigger, behind the `blume:ask` alias. Always written
      // (even when Ask is off, as a component that renders nothing) so the alias
      // resolves — the same contract as `blume:search-client`.
      write(askPath, askComponentTemplate(askEnabled)),
      write(join(srcDir, "generated", "components.ts"), slotPlan.module),
      write(
        join(srcDir, "generated", "islands.ts"),
        islandMapTemplate(islandDiscovery.islands)
      ),
      write(
        join(srcDir, "generated", "examples.ts"),
        exampleMapTemplate(exampleDiscovery.examples, config.basePath)
      ),
      // The isolated Tailwind entry for `<Component />` preview frames: only
      // example files (and the project sources they import) are scanned, so
      // the docs theme never reaches a preview.
      write(
        examplesThemePath,
        examplesEntryTemplate({
          configTokens: buildThemeCss(config.theme),
          sources: [`${context.root}/**/*.{astro,jsx,svelte,ts,tsx,vue}`],
          userCss: userExamplesCss,
        })
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
    ]),
    // Per-island hydration wrappers for the `islands/` convention. The map
    // module (written above, always) imports these; orphans from removed
    // islands are pruned at the end of the pass.
    Promise.all(
      islandDiscovery.islands.map((island) =>
        write(
          join(srcDir, "generated", "islands", `${island.name}.astro`),
          islandWrapperTemplate(island)
        )
      )
    ),
    // Per-override hydration wrappers for `defineComponents` islands and
    // `client:*` layout/mdx overrides. The generated `components.ts` (written
    // above) imports these; orphans from removed overrides are pruned at the
    // end of the pass.
    Promise.all(
      slotPlan.wrappers.map((wrapper) =>
        write(
          join(srcDir, "generated", "component-slots", `${wrapper.name}.astro`),
          wrapper.content
        )
      )
    ),
    // Per-example live wrappers for the `examples/` convention, resolved by
    // `<Component path>` through the `examples.ts` map (written above, always).
    Promise.all(
      exampleDiscovery.examples.map((example) =>
        write(
          join(
            srcDir,
            "generated",
            "examples",
            `${exampleSlug(example.path)}.astro`
          ),
          exampleWrapperTemplate(example)
        )
      )
    ),
    writeAskFiles(project, srcDir, write),
    writeMcpFiles(project, mcp, write),
  ]);

  if (config.seo.og.enabled) {
    await write(
      join(srcDir, "pages", "og", "[...slug].png.ts"),
      ogEndpointTemplate(ogRoutes)
    );
  }

  // Changelog index (`/changelog`), rendered through the Update timeline layout.
  if (hasGeneratedChangelog(project, pages)) {
    await write(
      join(srcDir, "pages", "changelog.astro"),
      changelogIndexTemplate({
        exportEpub,
        exportPdf,
        needsReact,
        staged: hasStaged,
      })
    );
  }

  // Three independent writes: the per-example preview routes that
  // `<Component />` iframes embed (returning a warning when the configured
  // examples.css is missing), the default 404 page (`/404`, unless the project
  // already owns the route), and the provider-specific client loader behind
  // the `blume:search-client` alias — always (re)generated so the alias
  // resolves even when search is disabled.
  const [examplesWarnings] = await Promise.all([
    writeExamplesPreview({
      config,
      hasExamples: exampleDiscovery.examples.length > 0,
      root: context.root,
      srcDir,
      write,
    }),
    writeNotFoundPage(write, srcDir, pages, project.graph.pages),
    write(searchClientPath, searchClientTemplate(config)),
  ]);

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
      rawMarkdownEndpointTemplate("md")
    ),
    write(
      join(srcDir, "pages", "[...slug].mdx.ts"),
      rawMarkdownEndpointTemplate("mdx")
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
  const warnings: string[] = [
    ...(depsLinkWarning ? [depsLinkWarning] : []),
    ...reactCompilerWarnings(config, needsReact, reactCompilerPath),
    ...mcp.warnings,
    ...islandDiscovery.warnings,
    ...exampleDiscovery.warnings,
    ...examplesWarnings,
    ...overrideWarnings,
  ];

  // Missing-navigation-target check, now that every servable route is known:
  // content routes, custom `.astro` pages, the generated changelog, and any
  // OpenAPI reference routes (so a tab an author points at one still validates).
  const navTargetRoutes = new Set<string>([
    ...project.graph.routes.keys(),
    ...pages.map((page) => page.pattern),
    ...referenceRoutes(config),
  ]);
  if (hasGeneratedChangelog(project, pages)) {
    navTargetRoutes.add("/changelog");
  }
  warnings.push(
    ...validateNavTargets(project.graph.navigation, navTargetRoutes).map(
      (diagnostic) =>
        diagnostic.suggestion
          ? `${diagnostic.message} ${diagnostic.suggestion}`
          : diagnostic.message
    )
  );

  // Unknown-component check: a `<Tag>` in MDX that isn't a built-in, an island,
  // or a `components.ts` override. Needs the project's own components, known here.
  const knownComponentTags = new Set<string>([
    ...islandDiscovery.islands.map((island) => island.name),
    ...overrideTags,
  ]);
  warnings.push(
    ...validateUsedComponents(
      project.graph.pages,
      knownComponentTags,
      new Set(registry.map((item) => item.name))
    ).map((diagnostic) =>
      diagnostic.suggestion
        ? `${diagnostic.message} ${diagnostic.suggestion}`
        : diagnostic.message
    )
  );

  // Provider SDKs are optional peers; warn (rather than fail opaquely in Vite)
  // when the configured provider's package isn't installed. A dep is available
  // if the project installed it (resolves from the root) OR Blume ships it
  // (resolves from the Blume package — the same set the `.blume` deps link
  // exposes to the build). Resolving from the project root alone falsely flagged
  // a shipped SDK like Orama (the default provider) as missing whenever it
  // wasn't hoisted into the project, e.g. under isolated linkers. We resolve
  // from each package's real location rather than through the `.blume` junction,
  // which can't be traversed reliably for store-symlinked deps.
  for (const dep of searchProviderMeta(config.search.provider).runtimeDeps) {
    if (
      !(canResolveFrom(context.root, dep) || canResolveFrom(packageRoot(), dep))
    ) {
      warnings.push(
        `Search provider "${config.search.provider}" needs "${dep}", which isn't installed. Run \`npm install ${dep}\` (or your package manager's equivalent).`
      );
    }
  }

  // React ships with Blume; Vue/Svelte islands need their Astro integration
  // installed by the project. Warn early rather than let Vite fail to resolve it.
  warnings.push(
    ...deploymentAdapterWarnings(config.deployment, context.root),
    ...islandFrameworkWarnings(frameworks, context.root)
  );
  if (hasScalarReferences(config)) {
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

  // The parsed OpenAPI specs behind the `blume:openapi` alias. Always written
  // (even as `{}`) so the alias resolves whether or not a reference is enabled;
  // the source parsed the specs during the scan, so this is just serialization.
  const openApiSource = project.sources.find(isOpenApiSource);
  // These write to distinct trees and never read one another, so they batch.
  // `data.json`/`openapi.json` and the manifest are not "structural" for Astro;
  // they hot-reload. `writeStagedContent` owns the `.blume/content` tree (its
  // own pruning), outside `.blume/src`, so a removed remote entry doesn't linger.
  await Promise.all([
    write(join(srcDir, "generated", "data.json"), buildRuntimeData(project)),
    write(
      openapiPath,
      `${JSON.stringify(openApiSource ? openApiSource.openApiData() : {})}\n`
    ),
    write(
      join(out, "blume.manifest.json"),
      `${JSON.stringify(project.manifest, null, 2)}\n`
    ),
    writeStagedContent(out, staged),
  ]);

  // Remove anything under `.blume/src` this pass didn't write — e.g. an Ask AI
  // endpoint left behind after the feature was switched off.
  await pruneOrphans(srcDir, written);

  return { structuralChange: structural.some(Boolean), warnings };
};

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { imageSize } from "image-size";
import pMap from "p-map";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "pathe";
import { glob } from "tinyglobby";

import { buildAskData } from "../ai/ask-data.ts";
import { askBackendRuntimeDep, resolveAskBackend } from "../ai/ask.ts";
import { buildRawMarkdown, markdownRoutePaths } from "../ai/markdown.ts";
import { buildMcpData } from "../ai/mcp/data.ts";
import { buildMcpDiscovery, buildMcpServerCard } from "../ai/mcp/discovery.ts";
import { normalizeBasePath } from "../core/base-path.ts";
import { validateUsedComponents } from "../core/component-diagnostics.ts";
import { analyzeComponentOverrides } from "../core/component-overrides.ts";
import {
  collectContentAssets,
  rewriteRelativeImages,
} from "../core/content-assets.ts";
import type {
  BlumeBanner,
  BlumeData,
  BlumeFavicon,
  BlumeLogo,
} from "../core/data.ts";
import { BlumeError } from "../core/diagnostics.ts";
import { writeTextAtomic } from "../core/fs-atomic.ts";
import { EN_UI, resolveUIStrings } from "../core/i18n-ui.ts";
import { resolveFallbackLocale } from "../core/i18n.ts";
import { buildIncludeGraph } from "../core/includes.ts";
import {
  validateNavTargets,
  validateSearchPopularIcons,
} from "../core/nav-diagnostics.ts";
import { packageRoot } from "../core/package-root.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import { resolveDocsCollection } from "../core/sources/resolve.ts";
import { resolveTsconfigAliases } from "../core/tsconfig-aliases.ts";
import type { Diagnostic, Navigation } from "../core/types.ts";
import { buildRssFeeds, renderRssFeed } from "../deploy/rss.ts";
import { missingFontFiles, resolveOgFonts } from "../og/derive.ts";
import type { DerivedOgFonts } from "../og/derive.ts";
import { resolveOgLogo } from "../og/logo.ts";
import type { ApiSpecData, OpenApiData } from "../openapi/model.ts";
import {
  builtinProxyKinds,
  hasScalarReferences,
  needsPlaygroundProxy,
  referenceRoutes,
} from "../openapi/references.ts";
import { buildReferenceFiles } from "../openapi/scalar.ts";
import { isOpenApiSource } from "../openapi/source.ts";
import { registry } from "../registry/registry.ts";
import { buildSearchDocuments } from "../search/documents.ts";
import { resolveSearchPopular } from "../search/popular.ts";
import { searchProviderMeta, servesStaticIndex } from "../search/providers.ts";
import {
  examplesEntryTemplate,
  tailwindEntryTemplate,
} from "../theme/entry.ts";
import { buildFontsCss, configuredFonts } from "../theme/fonts.ts";
import { buildThemeCss } from "../theme/palette.ts";
import { twoslashCss } from "../theme/twoslash.ts";
import { planComponentSlots } from "./component-slots.ts";
import type { ComponentSlotPlan } from "./component-slots.ts";
import { discoverExamples, exampleMarkdownLookup } from "./examples.ts";
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
  contentAssetsEndpointTemplate,
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
  playgroundProxyTemplate,
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
export const resolveReactCompiler = (
  config: ResolvedConfig,
  needsReact: boolean,
  pkgDir: string = packageRoot()
): string | null => {
  if (!(needsReact && config.react.compiler)) {
    return null;
  }
  try {
    return createRequire(pathToFileURL(join(pkgDir, "_.js")).href).resolve(
      "babel-plugin-react-compiler"
    );
  } catch {
    return null;
  }
};

/**
 * Warning (as a spreadable list) for the case where the React Compiler was
 * requested but its plugin couldn't be resolved — so the build silently drops
 * to uncompiled output rather than failing. Exported for testing.
 */
export const reactCompilerWarnings = (
  config: ResolvedConfig,
  needsReact: boolean,
  compilerPath: string | null
): string[] =>
  needsReact && config.react.compiler && !compilerPath
    ? [
        "React Compiler is enabled but `babel-plugin-react-compiler` could not be resolved; falling back to an uncompiled build. Reinstall Blume, or set `react: { compiler: false }` to silence this.",
      ]
    : [];

/** Resolve Astro's package.json directly inside a node_modules directory. */
const resolveAstroPackageJson = (modulesDir: string): string | null => {
  try {
    return realpathSync(join(modulesDir, "astro", "package.json"));
  } catch {
    return null;
  }
};

/**
 * The `astro` package reachable through the normal node_modules ancestor walk
 * from a generated runtime — its realpath'd `package.json` plus the
 * `node_modules` directory the walk found it in — or null when none resolves.
 *
 * This deliberately does not use `createRequire().resolve()`. pnpm's generated
 * bin shim adds Blume's virtual-store dependencies to `NODE_PATH`, which
 * CommonJS resolution honors but ESM package resolution ignores. The generated
 * Astro config uses ESM imports, so treating a NODE_PATH-only result as
 * reachable skips the dependency link and makes `import "astro/config"` fail.
 * Walking the physical node_modules ancestors mirrors the lookup that config
 * actually gets.
 *
 * The containing directory matters as much as the package: under an isolated
 * linker the walk can find a store-deduped astro in a directory that holds
 * nothing else of Blume's, so "the right astro resolves" does not imply "the
 * integrations resolve" — callers must check where the hit came from.
 */
const resolvedAstroHit = (
  fromDir: string
): { modulesDir: string; pkg: string } | null => {
  let dir = normalize(fromDir);
  while (true) {
    const modulesDir = join(dir, "node_modules");
    const pkg = resolveAstroPackageJson(modulesDir);
    if (pkg) {
      return { modulesDir, pkg };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
};

/**
 * Whether two paths name the same physical directory (realpath equality).
 * Exported for testing.
 */
export const sameRealDir = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/**
 * The two places an installer can put Blume's dependencies:
 *   - `<blume>/node_modules` — deps nested under the package (workspace source,
 *     or npm nesting them away from a conflicting hoisted copy)
 *   - `dirname(<blume>)`     — deps as siblings in the store (isolated/pnpm)
 *
 * `packageRoot()` resolves to Blume's real on-disk path (Node follows the
 * install symlink), so its parent is the store's package directory where the
 * isolated linker places the siblings.
 */
const depsCandidates = (pkgDir: string): string[] => [
  join(pkgDir, "node_modules"),
  dirname(pkgDir),
];

/** First dependency candidate containing the package dir `segments`, or null. */
const candidateHolding = (
  pkgDir: string,
  ...segments: string[]
): string | null =>
  depsCandidates(pkgDir).find((dir) => existsSync(join(dir, ...segments))) ??
  null;

/**
 * Locate the directory that holds Blume's installed dependencies (Astro and its
 * integrations).
 *
 * With a clean hoisted install this is moot — the deps sit in a `node_modules`
 * the generated `.blume/` already walks up into, and {@link ensureDepsLink}
 * short-circuits before we need it. But under isolated linkers (Bun's
 * `isolated` mode, pnpm) Blume's deps are NOT hoisted into the project; they
 * live beside the Blume package in a virtual store, invisible to the upward
 * walk from `.blume/` — so probe the {@link depsCandidates}.
 *
 * Astro alone is a bad probe: an npm split install (an `overrides` pin plus an
 * incremental install) hoists `astro` to the project root while Blume's other
 * deps stay nested, and probing for astro then picks the root directory — one
 * that holds none of them. Prefer a candidate with the full set (astro beside
 * `@astrojs/mdx`, the integration every generated runtime declares), then one
 * with the integrations (astro hoisted away — the rest of Blume's deps sit
 * there too), then one with astro alone.
 */
const holdsAstro = (dir: string): boolean => existsSync(join(dir, "astro"));
const holdsMdx = (dir: string): boolean =>
  existsSync(join(dir, "@astrojs", "mdx"));

export const blumeDepsDir = (pkgDir: string = packageRoot()): string | null => {
  const candidates = depsCandidates(pkgDir);
  return (
    candidates.find((dir) => holdsAstro(dir) && holdsMdx(dir)) ??
    candidates.find(holdsMdx) ??
    candidates.find(holdsAstro) ??
    null
  );
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
    // Already pointing at the right target — leave it alone. This runs on
    // every dev regeneration, and an unconditional rm+recreate opens a window
    // in which the Vite server's module resolution races a missing
    // `node_modules` and 500s intermittently.
    try {
      if (resolve(dirname(link), await readlink(link)) === resolve(depsDir)) {
        return;
      }
    } catch {
      // Unreadable link — replace it below.
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
 * Drop a `.blume/node_modules` junction that resolves a *different* Blume than
 * the one running. A restored build cache (e.g. Vercel's) can resurrect the
 * junction pointing into a superseded store directory — blume@1.1.0's isolated
 * deps dir after 1.1.1 was installed. Releases rarely bump Astro, so the stale
 * target still resolves the very same astro and every astro-based probe in
 * {@link ensureDepsLink} passes through the link — while the `blume/*` imports
 * in the freshly generated config load the previous release, crashing on any
 * export added since. Staleness is judged by realpath: the link is stale
 * exactly when the directory behind it holds a `blume` that isn't `pkgDir`.
 * A target with no `blume` entry (the workspace layout links
 * `packages/blume/node_modules`, which holds only the deps) resolves Blume
 * through the normal ancestor walk and stays. Real directories stay too,
 * mirroring {@link linkDepsJunction} — we only ever remove a link we own.
 */
const dropStaleDepsLink = async (
  link: string,
  pkgDir: string
): Promise<void> => {
  let existing: Awaited<ReturnType<typeof lstat>>;
  try {
    existing = await lstat(link);
  } catch {
    return;
  }
  if (!existing.isSymbolicLink()) {
    return;
  }
  let linkedBlume: string;
  let runningBlume: string;
  try {
    linkedBlume = await realpath(join(link, "blume"));
    runningBlume = await realpath(pkgDir);
  } catch {
    return;
  }
  if (linkedBlume !== runningBlume) {
    await rm(link, { force: true });
  }
};

/**
 * Make the generated runtime resolve Astro and its integrations against Blume's
 * own dependency set. Three failure modes this repairs:
 *
 *   - Astro is *unreachable* from `.blume/` (workspaces under isolated linkers,
 *     pnpm) — the deps live in a store the upward walk can't see.
 *   - Astro *resolves to the wrong copy* — a hoisted sibling pinned an older
 *     major (e.g. `astro@6` for a type-only import) that shadows Blume's
 *     `astro@7`, so `@astrojs/mdx@7` binds to it and crashes the build on a
 *     missing export. Resolving merely *an* astro isn't enough; it must be the
 *     same one Blume uses.
 *   - The *integrations* are unreachable while astro is fine — npm's split
 *     install. An `overrides` pin plus an incremental `npm install` hoists
 *     astro to the project root (deleting Blume's nested copy) but leaves
 *     `@astrojs/mdx` and friends nested under `blume/node_modules`, where the
 *     upward walk from `.blume/` can't see them. The same shape arises under
 *     an isolated linker when the workspace itself declares astro at a version
 *     matching Blume's: the store dedupes both to one copy, so the walk finds
 *     the "correct" astro through the workspace's own direct-dep symlink — in
 *     a node_modules holding none of Blume's other deps.
 *
 * The repair is the same symlink: Blume's dependency directory linked in as
 * `.blume/node_modules` so the generated config's bare specifiers (`astro`,
 * `@astrojs/mdx`, …) bind to a consistent set. That's safe when the linked
 * directory holds the full set, or when it holds only the integrations but the
 * runtime already resolves Blume's astro — the junction has no `astro` entry,
 * so astro lookups fall through to the hoisted copy the integrations bind to
 * anyway. What it can't fix is the inverse split: Blume's astro nested under a
 * *conflicting* hoisted astro with the integrations hoisted away from it. No
 * single directory yields a consistent set there; only a root `overrides`/
 * `resolutions` pin does, so we return a diagnostic naming the conflict rather
 * than silently shipping a runtime that crashes downstream. Returns the
 * warning, or null when nothing needs saying.
 */
export const ensureDepsLink = async (
  outDir: string,
  pkgDir: string = packageRoot()
): Promise<string | null> => {
  const astroDir = candidateHolding(pkgDir, "astro");
  if (!astroDir) {
    return null;
  }
  const mdxDir = candidateHolding(pkgDir, "@astrojs", "mdx");
  const blumeAstro = resolveAstroPackageJson(astroDir);
  // Before probing what `.blume/` resolves, drop a cache-restored junction
  // that binds it to a superseded Blume — the probes below would otherwise
  // pass right through it (same astro, older blume) and leave it in place.
  await dropStaleDepsLink(join(outDir, "node_modules"), pkgDir);
  const outDirHit = resolvedAstroHit(outDir);
  // `.blume/` resolves the very same astro Blume's deps provide.
  const astroCorrect = blumeAstro !== null && outDirHit?.pkg === blumeAstro;
  // Clean hoisted install: astro is correct, found in Blume's own dependency
  // directory, and the integrations sit beside it — the same walk resolves
  // them too, so there is nothing to do. Requiring the walk to land in
  // `astroDir` itself (not merely resolve an identical astro) matters under
  // isolated linkers: a workspace that declares astro at a version matching
  // Blume's gets a store-deduped symlink in its own node_modules, so the walk
  // finds the "correct" astro in a directory holding only the workspace's
  // direct deps — none of Blume's integrations (issue #103).
  const walkLandsInDeps =
    astroCorrect &&
    outDirHit !== null &&
    sameRealDir(outDirHit.modulesDir, astroDir);
  if (walkLandsInDeps && mdxDir === astroDir) {
    return null;
  }
  // Linking the integrations' directory yields a consistent set when it also
  // holds Blume's astro (the unreachable and repairable-conflict cases) or
  // when the correct astro is reachable without it (the npm split install).
  // Any existing link here is stale and gets replaced.
  if (mdxDir && (mdxDir === astroDir || astroCorrect)) {
    await linkDepsJunction(join(outDir, "node_modules"), mdxDir);
    return null;
  }
  // Split layout: Blume's astro is nested (a conflicting astro took the root
  // spot) but @astrojs/mdx hoisted away from it, binding to the shadow. Only a
  // root pin fixes this — surface it.
  return astroConflictWarning(blumeAstro, outDirHit?.pkg ?? null);
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
export interface PrerenderDepsPlugin {
  name: string;
  writeBundle: (options: { dir?: string }) => Promise<void>;
}

export const prerenderDepsPlugin = (
  pkgDir: string = packageRoot()
): PrerenderDepsPlugin => ({
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

/** Astro integration package each non-React island framework needs installed. */
const ISLAND_FRAMEWORK_DEPS = new Map([
  ["svelte", "@astrojs/svelte"],
  ["vue", "@astrojs/vue"],
]);

/**
 * Adapter package the project must install itself for each deployment
 * platform whose adapter Blume doesn't ship. Node and Vercel ship with Blume,
 * so they never need this.
 */
const DEPLOYMENT_ADAPTER_DEPS = new Map([
  ["cloudflare", "@astrojs/cloudflare"],
  ["netlify", "@astrojs/netlify"],
]);

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
    const dep = ISLAND_FRAMEWORK_DEPS.get(framework);
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
      ? DEPLOYMENT_ADAPTER_DEPS.get(deployment.adapter)
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

/**
 * Warn when the configured search provider's SDK is missing. Provider SDKs are
 * optional peers; warn (rather than fail opaquely in Vite) when the package
 * isn't installed. A dep is available if the project installed it (resolves
 * from the root) OR Blume ships it (resolves from the Blume package — the same
 * set the `.blume` deps link exposes to the build). Resolving from the project
 * root alone falsely flagged a shipped SDK like Orama (the default provider)
 * as missing whenever it wasn't hoisted into the project, e.g. under isolated
 * linkers. We resolve from each package's real location rather than through
 * the `.blume` junction, which can't be traversed reliably for store-symlinked
 * deps. `pkgDir` is injectable for testing.
 */
export const searchProviderWarnings = (
  provider: ResolvedConfig["search"]["provider"],
  root: string,
  pkgDir: string = packageRoot()
): string[] => {
  const warnings: string[] = [];
  for (const dep of searchProviderMeta(provider).runtimeDeps) {
    if (!(canResolveFrom(root, dep) || canResolveFrom(pkgDir, dep))) {
      warnings.push(
        `Search provider "${provider}" needs "${dep}", which isn't installed. Run \`npm install ${dep}\` (or your package manager's equivalent).`
      );
    }
  }
  return warnings;
};

/**
 * Warn when the Ask AI backend's provider SDK is missing. Like search provider
 * SDKs, these are optional peers the project must install (only `gateway`
 * needs nothing beyond the core `ai` package Blume ships) — warn early with
 * the package name rather than let Vite fail to resolve the import opaquely.
 * Same resolution rule as {@link searchProviderWarnings}: available if the
 * project installed it or Blume can resolve it. `pkgDir` is injectable for
 * testing.
 */
export const askProviderWarnings = (
  ask: ResolvedConfig["ai"]["ask"],
  root: string,
  pkgDir: string = packageRoot()
): string[] => {
  // An external `endpoint` means no generated route, so no SDK is imported.
  if (!ask?.enabled || ask.endpoint) {
    return [];
  }
  const dep = askBackendRuntimeDep(ask);
  if (!dep || canResolveFrom(root, dep) || canResolveFrom(pkgDir, dep)) {
    return [];
  }
  return [
    `Ask AI provider "${ask.provider}" needs "${dep}", which isn't installed. Run \`npm install ${dep}\` (or your package manager's equivalent).`,
  ];
};

/** Absolute path to the configured `examples.css`, or null when unset. */
const examplesCssFile = (
  root: string,
  config: ResolvedConfig
): string | null =>
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

/** Ceiling on concurrent content-file reads; unbounded fan-out risks EMFILE. */
const READ_CONCURRENCY = 16;

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
  const contents = await pMap(files, (file) => readOptional(join(root, file)), {
    concurrency: READ_CONCURRENCY,
  });
  return [...contents, ...staged].some(containsMath);
};

const hashConfigSource = (source: string): string =>
  createHash("sha256").update(source).digest("hex");

const loadIntegrationBridge = async (
  config: ResolvedConfig,
  context: BlumeProject["context"]
): Promise<Parameters<typeof astroConfigTemplate>[0]["integrationBridge"]> => {
  if (config.integrations.length === 0 || !context.configFile) {
    return;
  }
  return {
    configFile: relative(context.outDir, context.configFile),
    sourceHash: hashConfigSource(await readOptional(context.configFile)),
  };
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
  // Atomic temp-write + rename, so a watching dev server never observes a
  // missing or half-written file mid-regeneration.
  await writeTextAtomic(path, content);
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
      // A colocated `./image.png` reference resolves against `.blume/content`
      // once the body is materialized there, where the file does not exist.
      // Point it at the served original instead — the same rewrite the
      // agent-facing Markdown gets.
      const text = page.sourcePath
        ? rewriteRelativeImages({
            deployBase: project.config.deployment.base,
            projectRoot: project.context.root,
            source: page.body.text,
            sourcePath: page.sourcePath,
          })
        : page.body.text;
      staged.set(page.entryId, text);
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

/**
 * Read dimensions from an SVG's explicit size or its view box. Measured with
 * image-size — the same parser og/card.ts uses for the OG brand mark, so the
 * header and the card can't disagree about one logo — which also tolerates
 * the spellings the old regex missed (unquoted values, `em`/`pt` lengths, a
 * `>` inside another attribute). An SVG with no usable size returns partial
 * dimensions or throws; both collapse to undefined.
 */
const svgDimensions = (svg: string | undefined): LogoDimensions | undefined => {
  if (!svg) {
    return;
  }
  try {
    const { height, width } = imageSize(Buffer.from(svg));
    return height && width ? { height, width } : undefined;
  } catch {
    return undefined;
  }
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

/** Narrows a config union's string shorthand from its object form. */
const isStringShorthand = <T>(value: T | string): value is string =>
  typeof value === "string";

/**
 * The URL behind the header's repo mark. A string is used as-is: `github`
 * drives the per-page edit link, the header mark and the manifest's
 * `repository` together, so a project whose docs repo is private has to unset
 * all three, and would otherwise have no way to point the mark at anything.
 */
const headerRepoUrl = (
  repo: boolean | string,
  derived: string | null
): string | null => {
  if (isStringShorthand(repo)) {
    return repo;
  }
  return repo ? derived : null;
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
  const config = isStringShorthand(logo) ? { image: logo } : logo;
  // `text` is passed through verbatim: `undefined` lets the brand fall back to
  // the site title, `""` renders the mark alone (a logo with the wordmark baked
  // in).
  const { href, image: source, text } = config;
  const image = isStringShorthand(source) ? { light: source } : source;
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

/**
 * Derive the `-dark` sibling of an icon filename (`icon.svg` → `icon-dark.svg`),
 * inserting the suffix before the extension.
 */
const darkSibling = (name: string): string =>
  name.replace(/\.(?=[^.]+$)/u, "-dark.");

/** `<link type>` MIME for the favicon extensions we recognize. */
const FAVICON_TYPES = new Map([
  ["ico", "image/x-icon"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
]);

/** Infer the `<link type>` MIME from a filename, when we recognize the extension. */
const faviconType = (name: string): string | undefined => {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext ? FAVICON_TYPES.get(ext) : undefined;
};

/** Read a file and encode it as a `data:` URI of the given MIME type. */
const inlineDataUri = (file: string, type: string): string =>
  `data:${type};base64,${readFileSync(file).toString("base64")}`;

/**
 * The bundled Blume favicon, inlined as a data URI so it needs no public file.
 * The mark is dark, so it ships with a light-on-transparent dark-scheme variant —
 * otherwise it disappears against dark browser chrome.
 */
const defaultFavicon = (): BlumeFavicon => ({
  dark: {
    href: inlineDataUri(
      join(BLUME_SRC, "assets", "icon-dark.png"),
      "image/png"
    ),
    type: "image/png",
  },
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
 * when the project ships no `icon.*`/`favicon.*` file. The dark-scheme variant
 * is anchored to the resolved icon: its `-dark` sibling (e.g. `icon.svg` →
 * `icon-dark.svg`) in the same directory — never an unrelated `-dark` file, so a
 * stale or foreign `favicon-dark.*` can't silently pair with a different mark.
 * A `-dark` file with no light sibling is the site's only mark and is used for
 * both schemes, mirroring how `resolveLogo` treats a single-variant image.
 */
const resolveFavicon = (project: BlumeProject): BlumeFavicon => {
  const { root } = project.context;
  for (const name of FAVICON_CANDIDATES) {
    if (existsSync(join(root, "public", name))) {
      const type = faviconType(name);
      const sibling = darkSibling(name);
      return existsSync(join(root, "public", sibling))
        ? { dark: { href: `/${sibling}`, type }, href: `/${name}`, type }
        : { href: `/${name}`, type };
    }
  }
  for (const name of FAVICON_CANDIDATES) {
    const file = join(root, name);
    if (existsSync(file)) {
      const type = faviconType(name);
      const mime = type ?? "image/x-icon";
      const siblingFile = join(root, darkSibling(name));
      return existsSync(siblingFile)
        ? {
            dark: { href: inlineDataUri(siblingFile, mime), type },
            href: inlineDataUri(file, mime),
            type,
          }
        : { href: inlineDataUri(file, mime), type };
    }
  }
  return (
    resolveIconFile(project, FAVICON_CANDIDATES.map(darkSibling)) ??
    defaultFavicon()
  );
};

/**
 * Resolve the Apple touch icon by convention, or null when the project ships
 * none (unlike the favicon, there's no bundled default). Note: iOS ignores
 * `data:`-URI apple-touch-icons, so a `public/` file (served by URL) is the
 * reliable path; a root-level file is still inlined for symmetry with favicons.
 * Deliberately no `-dark` sibling detection here: iOS ignores `media` on
 * `apple-touch-icon` links, so a dark variant could never be served.
 */
const resolveAppleIcon = (project: BlumeProject): BlumeFavicon | null =>
  resolveIconFile(project, APPLE_ICON_CANDIDATES);

/** Normalize the banner config (string shorthand or object) for the runtime. */
const resolveBanner = (config: ResolvedConfig): BlumeBanner | null => {
  const { banner } = config;
  if (!banner) {
    return null;
  }
  if (isStringShorthand(banner)) {
    return { content: banner, dismissible: false, key: banner };
  }
  return {
    content: banner.content,
    dismissible: banner.dismissible,
    key: banner.id ?? banner.content,
    link: banner.link,
  };
};

/**
 * The OG card's brand mark: a `seo.og.logo` of `false` opts out of any mark,
 * a configured SVG wins over the site logo, and a non-SVG value resolves to
 * `undefined` (the card falls back to the accent-initial tile).
 */
const resolveOgMark = (
  project: BlumeProject,
  siteLogo: string | undefined
): string | false | undefined => {
  const configured = project.config.seo.og.logo;
  if (configured === false) {
    return false;
  }
  if (configured) {
    return resolveOgLogo(project, configured);
  }
  return siteLogo;
};

/**
 * The OG card's footer site text. A `seo.og.site` override wins (`false`
 * hides it); the default is the deployment site's host plus the normalized
 * deployment base — on a subpath deploy (a GitHub Pages project site) the
 * bare host is the platform's shared apex, not this site (#139).
 */
const resolveOgSite = (config: ResolvedConfig): string | undefined => {
  const configured = config.seo.og.site;
  if (configured === false) {
    return;
  }
  if (configured !== undefined) {
    return configured;
  }
  return config.deployment.site
    ? `${new URL(config.deployment.site).host}${normalizeBasePath(
        config.deployment.base
      )}`
    : undefined;
};

/** The OG card's subtitle: `seo.og.description` (`false` omits it) over the site description. */
const resolveOgDescription = (config: ResolvedConfig): string | undefined => {
  const configured = config.seo.og.description;
  if (configured === false) {
    return;
  }
  return configured ?? config.description;
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
  const ogLogo = resolveOgMark(project, logo?.svg);

  const editUrlFor = (sourcePath?: string): string | null => {
    if (!(editBase && sourcePath)) {
      return null;
    }
    const rel = relative(context.root, sourcePath).split("\\").join("/");
    // The edit path is repo-relative: `github.dir` places the project inside
    // the repo, so a source above the project dir (a monorepo vault beside the
    // docs app) still resolves to an in-repo file. A path that escapes the
    // repo itself has nothing to edit — fabricating one yields a 404 link.
    // `dir` is a bare string in the schema, so a leading slash (`/apps/docs`)
    // is trimmed rather than read as an absolute path — which would drop the
    // link from every page of a site that has always written it that way.
    const editDir = (github?.dir ?? "").replaceAll(/^\/+|\/+$/gu, "");
    const editPath = normalize(editDir ? join(editDir, rel) : rel);
    if (editPath.startsWith("..") || isAbsolute(editPath)) {
      return null;
    }
    return `${editBase}/${editPath}`;
  };

  const { i18n } = config;

  // Resolve the header repo link per locale. API references no longer add a tab
  // automatically — authors point a `navigation.tabs` entry at the reference
  // route to surface it (see `referenceRoutes`).
  const markUrl = headerRepoUrl(config.navigation.repo, repoUrl);
  const withRepoUrl = (nav: Navigation): Navigation => ({
    ...nav,
    repoUrl: markUrl,
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
              actions: [],
              cta: null,
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
        ? {
            endpoint: config.ai.ask.endpoint ?? null,
            suggestions: config.ai.ask.suggestions,
          }
        : null,
      banner: resolveBanner(config),
      basePath: config.basePath,
      codeThemes: config.markdown.codeBlocks.theme,
      codeWrap: config.markdown.code.wrap,
      dateFormat: config.dateFormat,
      description: config.description,
      discovery: {
        agentReadability: config.seo.agentReadability,
        llmsTxt: config.ai.llmsTxt.enabled,
        // Mirrors `buildSitemapFiles`: no site, no sitemap.
        sitemap: config.seo.sitemap && Boolean(config.deployment.site),
      },
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
      // `undefined` members drop out of the JSON snapshot; the null keeps the
      // "nothing configured" case explicit for the layouts.
      identity:
        config.seo.organization || config.seo.software
          ? {
              organization: config.seo.organization,
              software: config.seo.software,
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
      // Card fonts are baked into the generated OG endpoint (they can carry
      // absolute build-machine paths), not serialized here — this snapshot
      // ends up in every page's client data.
      og: {
        description: resolveOgDescription(config),
        enabled: config.seo.og.enabled ?? false,
        logo: ogLogo,
        palette: config.seo.og.palette,
        site: resolveOgSite(config),
      },
      openInChat: config.ai.openInChat,
      repoUrl,
      search: {
        enabled: config.search.provider !== "none",
        popular: resolveSearchPopular(config.search.popular, config.basePath),
        provider: config.search.provider,
      },
      site: config.deployment.site ?? null,
      structuredData: config.seo.structuredData,
      theme: config.theme,
      title: config.title,
      toc: config.toc,
      versions: config.versions ?? null,
      webmcp: {
        enabled: config.ai.webmcp,
        llms: config.ai.llmsTxt.enabled,
      },
      x: config.seo.x,
    },
    feeds: buildRssFeeds(project).map((feed) => ({
      href: feed.path,
      title: feed.title,
    })),
    // CSS variables for Astro's <Font> component; matches the astro.config
    // `fonts:` entries derived from the same theme.fonts config.
    fontCssVars: configuredFonts(config.theme.fonts),
    navigation: withRepoUrl(graph.navigation),
    // Per-locale navigation; the catch-all selects the active locale's tree.
    navigationByLocale,
    // Per-archived-version navigation; the catch-all selects by the route's
    // version, then locale.
    navigationByVersion: Object.fromEntries(
      Object.entries(graph.navigationByVersion).map(([id, byLocale]) => [
        id,
        Object.fromEntries(
          Object.entries(byLocale).map(([code, nav]) => [
            code,
            withRepoUrl(nav),
          ])
        ),
      ])
    ),
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
      version: route.version,
      versionAlternates: route.versionAlternates,
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
 * Decide whether to generate the playground's built-in CORS proxy endpoint.
 * Only the Blume renderer's playground with `proxy: true` needs it — a proxy
 * URL string points at an external service, and `false` sends requests
 * directly. Injected at `/_api-proxy` (rather than written under `pages/`)
 * because Astro treats `_`-prefixed page files as private; the endpoint's own
 * `prerender = false` export wins over the injection default.
 */
const planPlaygroundProxy = (config: ResolvedConfig, srcDir: string) => ({
  enabled: needsPlaygroundProxy(config),
  entrypoint: join(srcDir, "blume-openapi", "api-proxy.ts"),
  pattern: "/_api-proxy",
});

/**
 * The origins the built-in proxy is allowed to reach: one per absolute
 * `servers[].url` across the parsed specs. This is the endpoint's whole trust
 * boundary — the client sends the target as a query parameter, and a reader's
 * custom base URL is not a documented server — so it is derived here, at build
 * time, from the same documents the operation pages render.
 *
 * Relative (`/v1`) and templated (`{env}.api.example.com`) server URLs carry no
 * origin to allow and are skipped; AsyncAPI documents declare `servers` as a
 * map and contribute nothing (the proxy is OpenAPI-only).
 */
const specOriginsOf = (spec: ApiSpecData): string[] => {
  const origins = new Set<string>();
  // A GraphQL schema names no servers; its configured live endpoint is the
  // one origin the playground targets.
  if (spec.endpoint !== undefined) {
    try {
      origins.add(new URL(spec.endpoint).origin);
    } catch {
      // Not an absolute URL: nothing to allow.
    }
  }
  // SAFETY: `document` is arbitrary parsed JSON; the assertion only names
  // the optional `servers` shape, and every access below re-checks it —
  // `Array.isArray(servers)` guards the list and `server.url ?? ""` the url.
  const { servers } = spec.document as { servers?: { url?: string }[] };
  for (const server of Array.isArray(servers) ? servers : []) {
    const url = server.url ?? "";
    // `new URL("https://{region}.api.example.com")` parses — the braces land
    // in the hostname — so templated URLs need an explicit check or their
    // junk literal becomes an allowlist entry no real request can match.
    if (url.includes("{")) {
      continue;
    }
    try {
      origins.add(new URL(url).origin);
    } catch {
      // Not an absolute URL: nothing to allow.
    }
  }
  return [...origins];
};

const specOrigins = (data: OpenApiData): string[] =>
  [...new Set(Object.values(data).flatMap(specOriginsOf))].toSorted();

/**
 * Build-time diagnostics for playground sends the built-in proxy would refuse.
 * The baked-in allowlist pools every documented origin, but each spec's
 * playground only ever targets that spec's own servers/endpoint — so a
 * non-empty pool can still leave one spec's Send 403ing on every request.
 * Hence the check is per spec: any spec routed through the built-in proxy
 * whose own origins came out empty (no absolute `servers[].url`, no absolute
 * GraphQL `endpoint`) gets a warning naming it.
 */
const proxyAllowlistWarnings = (
  config: ResolvedConfig,
  data: OpenApiData
): string[] => {
  const kinds = builtinProxyKinds(config);
  const warnings: string[] = [];
  for (const spec of Object.values(data)) {
    if (!kinds.includes(spec.kind) || specOriginsOf(spec).length > 0) {
      continue;
    }
    warnings.push(
      spec.kind === "graphql"
        ? `The "${spec.label}" GraphQL reference (${spec.route}) has playground.proxy: true, but no absolute endpoint is configured for it, so the built-in proxy has no origin to allow and will refuse every request its playground sends. Set the graphql block's (or the source's) \`endpoint\` to the live GraphQL URL, or point playground.proxy at an external proxy URL.`
        : `The "${spec.label}" reference (${spec.route}) has playground.proxy: true, but its spec declares no absolute servers[].url (relative and templated URLs carry no origin), so the built-in proxy has no origin to allow and will refuse every request its playground sends. Add an absolute server URL to the spec, or point playground.proxy at an external proxy URL.`
    );
  }
  return warnings;
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
  if (!(ask?.enabled && !ask.endpoint)) {
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
    askEndpointTemplate(resolveAskBackend(ask), grounded, {
      instructions: ask.instructions,
      retrieval: ask.retrieval,
    })
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

/**
 * Flatten a diagnostic to a single warning line, appending the suggestion when
 * one exists. Exported for testing.
 */
export const diagnosticWarning = (diagnostic: Diagnostic): string =>
  diagnostic.suggestion
    ? `${diagnostic.message} ${diagnostic.suggestion}`
    : diagnostic.message;

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

/** The OG endpoint fonts for a scanned project (see {@link resolveOgFonts}). */
const projectOgFonts = (project: BlumeProject): DerivedOgFonts =>
  resolveOgFonts(
    {
      ogFonts: project.config.seo.og.fonts,
      themeFonts: project.config.theme.fonts,
      themeFontsConfigured: project.themeFontsConfigured,
    },
    project.context.root
  );

/**
 * Fail generation when a configured local font file is missing. Warning and
 * continuing is not an option here — the path is emitted into the Astro
 * config and the OG endpoint, which would crash later with a bare ENOENT.
 */
const assertFontFilesExist = (project: BlumeProject): void => {
  const { config, context } = project;
  const missing = missingFontFiles(
    { ogFonts: config.seo.og.fonts ?? [], themeFonts: config.theme.fonts },
    context.root
  );
  if (missing.length > 0) {
    throw new BlumeError({
      code: "BLUME_FONT_FILE_MISSING",
      message: `Configured font file(s) not found: ${missing.join(", ")}. Font paths resolve relative to the project root.`,
      severity: "error",
    });
  }
};

/**
 * Write (or update) the generated `.blume/` Astro runtime for a project.
 * Only files whose content changed are rewritten so Vite HMR stays fast.
 */
export const generateRuntime = async (
  project: BlumeProject
): Promise<GenerateResult> => {
  const { context, config } = project;
  assertFontFilesExist(project);
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
    integrationBridge,
    islandDiscovery,
    exampleDiscovery,
    componentSlots,
  ] = await Promise.all([
    context.pagesRoot ? discoverPages(context.pagesRoot) : Promise.resolve([]),
    detectNeedsReact(context.root),
    detectUsesMath(context.root, staged.values()),
    readOptional(context.themeFile),
    readOptional(examplesCssFile(context.root, config)),
    loadIntegrationBridge(config, context),
    discoverIslands(context.root),
    discoverExamples(context.root, config.examples.source),
    buildComponentSlots(context.componentsFile),
  ]);
  const {
    plan: slotPlan,
    tags: overrideTags,
    warnings: overrideWarnings,
  } = componentSlots;
  // Expose the discovered examples for agent-facing Markdown downleveling
  // (`<Component>` → source) before any consumer (raw `.md`, MCP, llms) runs.
  project.examples = exampleMarkdownLookup(exampleDiscovery.examples);

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
  const ogRoutes = customOgRoutes(pages, config.title, config.seo.og.titles);

  // Whether the generated `/changelog` index exists — shared by the OG endpoint
  // (which adds the index's own card) and the page write below. Computed here,
  // before the MCP discovery pages are appended, on the user's own pages.
  const changelogIndex = hasGeneratedChangelog(project, pages);

  // The hosted MCP server. The `.well-known` discovery docs are injected as
  // prerendered routes alongside user pages; the server endpoint itself is a
  // normal (server-rendered) page written by `writeMcpFiles`.
  const mcp = planMcp(project, srcDir, pages);
  pages.push(...mcp.discoveryPages);

  // The parsed OpenAPI specs behind the `blume:openapi` alias, also the source
  // of the proxy's origin allowlist below. The source parsed them during the
  // scan, so reading them here is free.
  const openApiSource = project.sources.find(isOpenApiSource);
  const openApiData = openApiSource ? openApiSource.openApiData() : {};

  // The playground's built-in CORS proxy rides the same injection path as the
  // MCP discovery docs; the endpoint itself opts out of prerendering.
  const playgroundProxy = planPlaygroundProxy(config, srcDir);
  if (playgroundProxy.enabled) {
    pages.push({
      entrypoint: playgroundProxy.entrypoint,
      pattern: playgroundProxy.pattern,
    });
  }
  // Computed once: the endpoint template bakes it in below. A spec that
  // contributes no origin of its own gets a per-spec diagnostic
  // (`proxyAllowlistWarnings`) — the proxy would refuse its every send.
  const proxyOrigins = specOrigins(openApiData);

  const hasStaged = staged.size > 0;
  // Only emit a project-scanning `docs` collection when a filesystem source
  // actually feeds it. An all-staged project (openapi/notion/…) has only staged
  // sources, so the `docs` glob would otherwise scan (and watch) the whole
  // project root for nothing — see contentConfigTemplate.
  const hasFilesystemSource = project.sources.some((source) => !source.staged);
  const docsCollection = resolveDocsCollection(config, context);

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
          contentRoot: docsCollection.base,
          contentRoutes: markdownRoutePaths(project),
          context,
          dataPath,
          examplesPath,
          examplesThemePath,
          integrationBridge,
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
          collection: docsCollection,
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
    playgroundProxy.enabled
      ? write(playgroundProxy.entrypoint, playgroundProxyTemplate(proxyOrigins))
      : Promise.resolve(false),
  ]);

  if (config.seo.og.enabled) {
    await write(
      join(srcDir, "pages", "og", "[...slug].png.ts"),
      ogEndpointTemplate(ogRoutes, projectOgFonts(project), changelogIndex)
    );
  }

  // Changelog index (`/changelog`), rendered through the Update timeline layout.
  if (changelogIndex) {
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

  // The include graph (partial → including pages) behind `includeHmrPlugin`:
  // editing a partial invalidates every page that splices it. Written even
  // when empty so the plugin's configured path always resolves.
  await write(
    join(srcDir, "generated", "includes.json"),
    `${JSON.stringify(buildIncludeGraph(project.graph.pages))}\n`
  );

  const rawMarkdown = await buildRawMarkdown(project);
  // The originals behind the rewritten `/blume-assets/content/…` references in
  // the agent-facing Markdown, plus the endpoint that serves them (and the
  // remote-source assets materialized under `.blume/public/blume-assets`).
  const contentAssets = await collectContentAssets(project);
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
    write(
      join(srcDir, "generated", "content-assets.json"),
      `${JSON.stringify(contentAssets)}\n`
    ),
    write(
      join(srcDir, "pages", "blume-assets", "[...asset].ts"),
      contentAssetsEndpointTemplate(
        join(project.context.outDir, "public", "blume-assets")
      )
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

  // Scalar-rendered API/AsyncAPI reference pages (`renderer: "scalar"`). One
  // self-contained page per source, mounted on its configured route and
  // regenerated each run.
  const warnings: string[] = [
    ...(depsLinkWarning ? [depsLinkWarning] : []),
    ...proxyAllowlistWarnings(config, openApiData),
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
  if (changelogIndex) {
    navTargetRoutes.add("/changelog");
  }
  // Curated `search.popular` icons live outside the navigation model, so they
  // miss `validateNavIcons` in the graph build — they're checked here too,
  // where the search config is known. A typo otherwise just renders the
  // default glyph.
  warnings.push(
    ...[
      ...validateNavTargets(project.graph.navigation, navTargetRoutes),
      ...validateSearchPopularIcons(config.search.popular),
    ].map(diagnosticWarning)
  );

  // Unknown-component check: a `<Tag>` in MDX that isn't a built-in, an island,
  // or a `components.ts` override. Needs the project's own components, known here.
  const knownComponentTags = new Set<string>([
    ...islandDiscovery.islands.map((island) => island.name),
    ...overrideTags,
  ]);
  // Missing-dependency preflights: the search provider's SDK, the Ask AI
  // backend's provider SDK, the deployment adapter's package, and — since
  // React ships with Blume while Vue/Svelte don't — any island framework's
  // Astro integration. Warn early rather than let Vite fail to resolve them
  // opaquely.
  warnings.push(
    ...validateUsedComponents(
      project.graph.pages,
      knownComponentTags,
      new Set(registry.map((item) => item.name))
    ).map(diagnosticWarning),
    ...searchProviderWarnings(config.search.provider, context.root),
    ...askProviderWarnings(config.ai.ask, context.root),
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

  // `openapi.json` (the `blume:openapi` alias) is always written — even as `{}`
  // — so the alias resolves whether or not a reference is enabled; the specs
  // were parsed during the scan, so this is just serialization.
  // These write to distinct trees and never read one another, so they batch.
  // `data.json`/`openapi.json` and the manifest are not "structural" for Astro;
  // they hot-reload. `writeStagedContent` owns the `.blume/content` tree (its
  // own pruning), outside `.blume/src`, so a removed remote entry doesn't linger.
  await Promise.all([
    write(join(srcDir, "generated", "data.json"), buildRuntimeData(project)),
    write(openapiPath, `${JSON.stringify(openApiData)}\n`),
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

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { dirname, isAbsolute, join, relative } from "pathe";

import { askBackendRuntimeDep } from "../ai/ask.ts";
import type { AskBackend } from "../ai/ask.ts";
import { normalizeBasePath } from "../core/base-path.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import { BLUME_IGNORE_DIRS } from "../core/sources/watch.ts";
import { trimChar } from "../core/trim.ts";
import type { ProjectContext } from "../core/types.ts";
import { applyBaseToAstroRedirects } from "../deploy/redirects.ts";
import { hasScalarReferences } from "../openapi/references.ts";
import { searchProviderMeta } from "../search/providers.ts";
import { buildFontEntries } from "../theme/fonts.ts";
import type { ExampleSpec } from "./examples.ts";
import type { BlumePageRoute } from "./integration.ts";
import type { IslandSpec } from "./islands.ts";
import type { OgCustomRoute } from "./pages.ts";

const WORKSPACE_MARKERS = [
  ".git",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
];

/** True when the package.json at this path declares a `workspaces` field. */
const hasWorkspacesField = (pkgPath: string): boolean => {
  if (!existsSync(pkgPath)) {
    return false;
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      workspaces?: unknown;
    };
    return pkg.workspaces !== undefined;
  } catch {
    return false;
  }
};

/** True when a directory looks like a workspace/monorepo root. */
const hasWorkspaceMarker = (dir: string): boolean =>
  hasWorkspacesField(join(dir, "package.json")) ||
  WORKSPACE_MARKERS.some((marker) => existsSync(join(dir, marker)));

/**
 * Walk up from the project root to the workspace/monorepo root so Vite's
 * `fs.allow` can reach hoisted dependencies — e.g. KaTeX fonts that resolve to
 * a monorepo root `node_modules` outside the project directory. Falls back to
 * the project root when no workspace markers are found.
 */
const findWorkspaceRoot = (start: string): string => {
  let dir = start;
  for (;;) {
    if (hasWorkspaceMarker(dir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return start;
    }
    dir = parent;
  }
};

const ADAPTER_IMPORTS: Record<string, string> = {
  cloudflare: "@astrojs/cloudflare",
  netlify: "@astrojs/netlify",
  node: "@astrojs/node",
  vercel: "@astrojs/vercel",
};

const ADAPTER_OPTIONS: Record<string, string> = {
  node: '{ mode: "standalone" }',
};

const WRANGLER_CONFIG_FILES = [
  "wrangler.jsonc",
  "wrangler.json",
  "wrangler.toml",
];

const resolveCloudflareAdapterArgs = (context: ProjectContext): string => {
  const args: string[] = ['prerenderEnvironment: "node"'];
  const wranglerPath = WRANGLER_CONFIG_FILES.map((file) =>
    join(context.root, file)
  ).find((file) => existsSync(file));
  if (wranglerPath) {
    let configPath = relative(context.outDir, wranglerPath);
    // The wrangler config always lives at the project root, above the `.blume`
    // runtime, so `relative` yields a `../…` path; normalize the theoretical
    // sibling case to an explicit `./` so it reads as a relative import.
    if (!configPath.startsWith(".") && !configPath.startsWith("/")) {
      configPath = `./${configPath}`;
    }
    args.push(`configPath: ${JSON.stringify(configPath)}`);
  }
  return `{ ${args.join(", ")} }`;
};

/**
 * Integration packages the generated runtime imports. Declaring them in
 * `.blume/package.json` lets Astro's framework-package crawl discover and bundle
 * them — notably the React renderer's server entry, which imports the
 * `astro:react:opts` virtual module and must not be externalized (this applies
 * across the `ssr`, `prerender`, and `client` Vite environments).
 */
export const runtimeDependencies = (options: {
  config: ResolvedConfig;
  needsReact: boolean;
  needsVue?: boolean;
  needsSvelte?: boolean;
}): string[] => {
  const { config, needsReact, needsSvelte, needsVue } = options;
  const deps = ["@astrojs/mdx"];
  if (needsReact) {
    deps.push("@astrojs/react");
  }
  if (needsVue) {
    deps.push("@astrojs/vue");
  }
  if (needsSvelte) {
    deps.push("@astrojs/svelte");
  }
  // The Scalar integration is only declared for a Scalar-rendered reference
  // (the `renderer: "scalar"` fallback, or AsyncAPI). Blume-rendered OpenAPI
  // parses at generate time and needs no runtime Scalar dependency.
  if (hasScalarReferences(config)) {
    deps.push("@scalar/astro");
  }
  // Only the configured search provider's SDK is declared, so a project pulls in
  // (and the user installs) exactly the backend it uses — nothing more.
  deps.push(...searchProviderMeta(config.search.provider).runtimeDeps);
  // Ask AI's provider SDK, when its backend needs one (gateway uses core `ai`).
  if (config.ai.ask?.enabled) {
    const askDep = askBackendRuntimeDep(config.ai.ask);
    if (askDep) {
      deps.push(askDep);
    }
  }
  const { deployment } = config;
  if (deployment.output === "server" && deployment.adapter) {
    const adapter = ADAPTER_IMPORTS[deployment.adapter];
    if (adapter) {
      deps.push(adapter);
    }
  }
  return deps;
};

/** Generate `.blume/astro.config.mjs`. */
/**
 * Render project tsconfig path aliases as `vite.resolve.alias` object entries.
 * Longest find first, so a more specific prefix (`@components`) is matched
 * before a broader one (`@`); these follow Blume's `blume:*` aliases, which
 * never overlap with a project's.
 */
/**
 * Blume's render-time dependencies, forced external on the build's SSR and
 * static-prerender Vite environments.
 *
 * Two reasons a dep lands here:
 *   - `takumi-js` (OG image rendering) loads `@takumi-rs/core`, a native NAPI
 *     addon that finds its platform-specific `.node` binding via
 *     `createRequire(import.meta.url)`. Bundling it relocates `import.meta.url`
 *     and breaks the binding lookup ("Cannot find native binding") on other
 *     platforms (e.g. the Linux CI runner), so it must resolve from
 *     `node_modules` at runtime instead. The prerender env matches these by
 *     exact specifier, so every entry point Blume imports has to be listed:
 *     the bare `takumi-js` (render) plus `takumi-js/helpers` (the `googleFonts`
 *     OG-font loader). The `@takumi-rs/*` packages are listed too so the native
 *     backend is never pulled into a chunk down any transitive path.
 *   - The rest are pure-JS packages kept external so an isolated linker (Bun's
 *     `isolated` mode, pnpm) doesn't bundle their symlinked store copies. When
 *     Vite bundles such a package but leaves its own `node_modules` child
 *     external, that child surfaces as an unresolvable bare import in the
 *     prerender chunk (e.g. `batchwork` via `@astrojs/markdown-satteri`). Kept
 *     external, each package's transitive imports resolve relative to its real
 *     store location — reachable through the `node_modules` junction {@link
 *     prerenderDepsPlugin} drops beside the prerender bundle.
 *
 * Astro 7 configures externalization per Vite environment, so this must be
 * applied to both `prerender` (static) and `ssr` (server) — a top-level
 * `ssr.external` only reaches the latter.
 */
const RENDER_EXTERNAL_DEPS = [
  "@astrojs/markdown-satteri",
  "@pierre/diffs",
  "@shikijs/transformers",
  "@takumi-rs/core",
  "@takumi-rs/helpers",
  "@takumi-rs/wasm",
  "github-slugger",
  "katex",
  "shiki",
  "simple-icons",
  "takumi-js",
  "takumi-js/helpers",
  "zod",
];

const renderUserAliases = (
  aliases: Record<string, string> | undefined
): string =>
  Object.entries(aliases ?? {})
    .toSorted(([a], [b]) => b.length - a.length)
    .map(
      ([find, replacement]) =>
        `\n        ${JSON.stringify(find)}: ${JSON.stringify(replacement)},`
    )
    .join("");

/** Astro's build output dir: the runtime's own `distDir`, else `<root>/dist`. */
const astroOutDir = (context: ProjectContext): string =>
  context.distDir ?? `${context.root}/dist`;

/**
 * The root a deploy adapter is shown, in place of the `.blume` runtime Astro
 * actually roots at. Adapters assume `outDir` is `<root>/dist` and resolve their
 * own output (and Vercel's dependency trace) against `root`, so the root implied
 * by Blume's `outDir` is the one that keeps that assumption true. See
 * {@link withAdapterRoot}.
 *
 * For a normal build that is the project root (`<project>/dist` -> `<project>`).
 * For a relocated runtime (`blume build --isolated`) it is the runtime dir
 * itself (`<runtime>/dist` -> `<runtime>`), keeping a verify build's adapter
 * output self-contained instead of overwriting the real `.vercel/output`.
 */
const adapterRoot = (context: ProjectContext): string =>
  dirname(astroOutDir(context));

/**
 * Excludes Vite's pre-bundled dep cache from @vitejs/plugin-react. Astro's
 * react() replaces the plugin's default `/node_modules/` exclude with just
 * `/\.astro$/`, so without this Babel re-parses every optimized dep chunk
 * served from `.vite/deps` — a 500KB+ vendor bundle per chunk, re-done on each
 * re-optimization. A blanket `/node_modules/` exclude would instead switch the
 * React Compiler off for Blume's own components in published installs (they
 * resolve under `node_modules/blume/src`, and exclude beats include in the
 * plugin's filter), so only the pre-bundle cache is excluded.
 */
const REACT_EXCLUDE = String.raw`exclude: [/\/node_modules\/\.vite\//]`;

/**
 * The `react()` integration call. When `compilerPath` is set (the resolved
 * absolute path to `babel-plugin-react-compiler`), react() carries the compiler
 * as the first babel plugin — an absolute path, because @vitejs/plugin-react
 * resolves babel plugins from the *project* root, not `.blume/`, so a bare
 * specifier wouldn't resolve in a user project. `target: "19"` matches Blume's
 * React pin. `null`/`undefined` (compiler off or unresolvable) omits the babel
 * block. Both variants carry the pre-bundle exclude above.
 */
const reactIntegration = (compilerPath: string | null | undefined): string =>
  compilerPath
    ? `react({ babel: { plugins: [[${JSON.stringify(compilerPath)}, { target: "19" }]] }, ${REACT_EXCLUDE} })`
    : `react({ ${REACT_EXCLUDE} })`;

/**
 * The `server.watch` block for the generated dev config. Keeps the watcher out
 * of Astro's cache dir — but ONLY when the docs collection is rooted at a
 * directory containing the runtime dir (a migrated, `content.root: "."`
 * project). There, the glob loader's watcher match (`picomatch.isMatch(entry,
 * pattern)` with array-OR semantics, where any negated pattern matches
 * unrelated files) fires on every `.blume/.astro` write — "No entry type
 * found" noise, and a `data-store.json` event can re-ingest the store file as
 * a JSON entry and loop the sync. Everywhere else the watcher MUST see
 * `.astro/data-store.json`: its change events are the only trigger for
 * Astro's dev-time content invalidation (see vite-plugin-content-virtual-mod),
 * and `.md` bodies are rendered into the store at load time — so ignoring the
 * file serves stale `.md` HTML on every request until the server restarts,
 * even though the loader logs a reload.
 */
const devWatchOption = (
  outDir: string,
  contentWatchesRuntimeDir: boolean | undefined
): string =>
  contentWatchesRuntimeDir
    ? `
      // Astro's cache dir sits inside the docs collection, whose watcher would
      // otherwise churn (and can loop) on Astro's own writes. Trade-off: .md
      // body edits need a dev-server restart in this layout.
      watch: {
        ignored: ${JSON.stringify([join(outDir, ".astro", "**")])},
      },`
    : "";

export const astroConfigTemplate = (options: {
  context: ProjectContext;
  config: ResolvedConfig;
  needsReact: boolean;
  needsVue?: boolean;
  needsSvelte?: boolean;
  pages: BlumePageRoute[];
  contentRoutes: string[];
  /** The generated Ask trigger (`blume:ask`); renders nothing when Ask is off. */
  askPath: string;
  dataPath: string;
  examplesPath: string;
  /** The example-preview Tailwind entry (`blume:examples-theme`). */
  examplesThemePath: string;
  themePath: string;
  searchClientPath: string;
  openapiPath: string;
  /**
   * Absolute path to `babel-plugin-react-compiler` when the React Compiler is
   * enabled (resolved from Blume's package root by the caller); null/absent
   * disables the compiler and emits a bare `react()`.
   */
  reactCompilerPath?: string | null;
  /** Project tsconfig path aliases (`find` -> absolute dir), e.g. `@` -> src. */
  aliases?: Record<string, string>;
  /**
   * Whether the filesystem `docs` collection is rooted at a directory that
   * contains the runtime dir (a migrated, `content.root: "."` project) — the
   * only layout where the dev watcher must be kept out of Astro's cache dir.
   * See {@link devWatchOption} for why this must stay scoped.
   */
  contentWatchesRuntimeDir?: boolean;
}): string => {
  const { context, config, needsReact, pages, dataPath, themePath } = options;
  const {
    askPath,
    contentRoutes,
    examplesPath,
    examplesThemePath,
    needsSvelte,
    needsVue,
    openapiPath,
    searchClientPath,
  } = options;
  const { deployment } = config;
  const userAliasLines = renderUserAliases(options.aliases);
  const server = deployment.output === "server";

  // The project root plus the workspace root, so hoisted dependencies (e.g.
  // KaTeX fonts under a monorepo's root node_modules) stay servable in dev.
  const fsAllow = [...new Set([findWorkspaceRoot(context.root), context.root])];

  const adapterImport =
    server && deployment.adapter
      ? `import adapter from "${ADAPTER_IMPORTS[deployment.adapter]}";\n`
      : "";
  const adapterArgs = (() => {
    if (!server || !deployment.adapter) {
      return "";
    }
    if (deployment.adapter === "cloudflare") {
      return resolveCloudflareAdapterArgs(context);
    }
    return ADAPTER_OPTIONS[deployment.adapter] ?? "";
  })();
  // Vercel resolves its Build Output tree and its `@vercel/nft` dependency
  // trace against the Astro root, which for Blume is the hidden `.blume`
  // runtime — leaving the traced function without its chunks or node_modules.
  // The other adapters emit into `outDir` (cloudflare, node) or are surfaced
  // afterwards (netlify), so none of them read `root` this way.
  const adapterExpr =
    deployment.adapter === "vercel"
      ? `withAdapterRoot(adapter(${adapterArgs}), ${JSON.stringify(adapterRoot(context))})`
      : `adapter(${adapterArgs})`;
  const adapterOption =
    server && deployment.adapter ? `\n  adapter: ${adapterExpr},` : "";

  const siteOption = deployment.site
    ? `\n  site: ${JSON.stringify(deployment.site)},`
    : "";
  const baseOption = deployment.base
    ? `\n  base: ${JSON.stringify(deployment.base)},`
    : "";

  // Astro's native i18n gives locale-aware helpers + `<html lang>` correctness.
  // Blume owns getStaticPaths and materializes fallback routes in the manifest,
  // so we deliberately omit Astro's `fallback` to keep one source of routing.
  const i18nOption = config.i18n
    ? `\n  i18n: ${JSON.stringify({
        defaultLocale: config.i18n.defaultLocale,
        locales: config.i18n.locales.map((locale) => locale.code),
        routing: {
          prefixDefaultLocale: !config.i18n.hideDefaultLocalePrefix,
        },
      })},`
    : "";

  // Base the redirect paths the same way routes are based, so a redirect lands
  // under `basePath` too. Astro layers its own `base` (deployment.base) onto
  // `from` when matching, but never onto `to` — see applyBaseToAstroRedirects.
  const basedRedirects = applyBaseToAstroRedirects(
    config.redirects,
    config.basePath,
    deployment.base ?? ""
  );
  const redirectsOption =
    basedRedirects.length > 0
      ? `\n  redirects: ${JSON.stringify(
          Object.fromEntries(
            basedRedirects.map((redirect) => [
              redirect.from,
              { destination: redirect.to, status: redirect.status },
            ])
          )
        )},`
      : "";

  // Self-hosted Google Fonts via Astro's Fonts API, derived from theme.fonts.
  // `fontProviders` is only imported when at least one font is configured.
  const fontEntries = buildFontEntries(config.theme.fonts);
  const fontsOption = fontEntries.length
    ? `\n  fonts: [${fontEntries
        .map(
          (font) =>
            `{ provider: fontProviders.google(), name: ${JSON.stringify(
              font.name
            )}, cssVariable: ${JSON.stringify(
              font.cssVariable
            )}, weights: ${JSON.stringify(
              font.weights
            )}, fallbacks: ${JSON.stringify(font.fallbacks)} }`
        )
        .join(", ")}],`
    : "";
  const defineConfigImport = fontEntries.length
    ? `import { defineConfig, fontProviders } from "astro/config";`
    : `import { defineConfig } from "astro/config";`;

  // Framework renderers are only wired in when an island (or Ask AI, for React)
  // needs them. The core theme is Astro-first and ships no client JS.
  const reactImport = needsReact ? `import react from "@astrojs/react";\n` : "";
  const vueImport = needsVue ? `import vue from "@astrojs/vue";\n` : "";
  const svelteImport = needsSvelte
    ? `import svelte from "@astrojs/svelte";\n`
    : "";
  const blumeImports = [
    "blumeIntegration",
    "prerenderDepsPlugin",
    "serverAppResolvePlugin",
    ...(adapterOption.includes("withAdapterRoot") ? ["withAdapterRoot"] : []),
  ];
  const blumeImport = `import { ${blumeImports.join(", ")} } from "blume/astro";\n`;

  // Twoslash runs first, before the always-on transformers, but only on fences
  // with the `twoslash` meta (explicitTrigger) — so it's opt-in per block with
  // no config flag; the TypeScript compiler only spins up when a block uses it.
  // Blume's preconfigured transformer compiles with the package's own pinned
  // classic TypeScript, so the user's project can be on any version (see
  // markdown/twoslash.ts).
  const twoslashTransformer = "blumeTwoslashTransformer(), ";

  // Content links are rewritten to their real served URL: the `deployment.base`
  // subdirectory (Astro doesn't rewrite `<a href>`) layered over the site-wide
  // `basePath` baked into routes. The layers are passed separately so a
  // hand-written `basePath` link (`/docs/x`) isn't double-prefixed (see
  // `withComposedBasePath`). The link checker validates the base-less authored
  // path against `basePath` routes separately.
  const deployBase = normalizeBasePath(deployment.base);

  const integrations = [
    `mdx({ processor: blumeMdxProcessor(${JSON.stringify({
      basePath: config.basePath,
      codeThemes: config.markdown.codeBlocks.theme,
      deployBase,
      headingAnchors: config.markdown.headingAnchors,
    })}) })`,
  ];
  if (needsReact) {
    integrations.push(reactIntegration(options.reactCompilerPath));
  }
  if (needsVue) {
    integrations.push("vue()");
  }
  if (needsSvelte) {
    integrations.push("svelte()");
  }
  // Always mounted: injects user pages (a no-op when there are none) and wires
  // up dev-server `Accept: text/markdown` negotiation over the content routes.
  integrations.push(
    `blumeIntegration(${JSON.stringify({ base: deployment.base, contentRoutes, pages })})`
  );

  const watchOption = devWatchOption(
    context.outDir,
    options.contentWatchesRuntimeDir
  );

  return `// Generated by Blume. Do not edit; this file is recreated on each run.
${defineConfigImport}
import mdx from "@astrojs/mdx";
import tailwindcss from "@tailwindcss/vite";
import { blumeMarkdownProcessor, blumeMdxProcessor, blumeShikiTransformers, blumeTwoslashTransformer } from "blume/markdown";
${reactImport}${vueImport}${svelteImport}${blumeImport}${adapterImport}
export default defineConfig({
  root: ${JSON.stringify(context.outDir)},
  srcDir: ${JSON.stringify(`${context.outDir}/src`)},
  outDir: ${JSON.stringify(astroOutDir(context))},
  publicDir: ${JSON.stringify(`${context.root}/public`)},
  output: ${JSON.stringify(deployment.output)},${adapterOption}${siteOption}${baseOption}${redirectsOption}${i18nOption}${fontsOption}
  integrations: [${integrations.join(", ")}],
  markdown: {
    processor: blumeMarkdownProcessor(${JSON.stringify({
      basePath: config.basePath,
      codeThemes: config.markdown.codeBlocks.theme,
      deployBase,
      headingAnchors: config.markdown.headingAnchors,
    })}),
    shikiConfig: {
      themes: {
        light: ${JSON.stringify(config.markdown.codeBlocks.theme.light)},
        dark: ${JSON.stringify(config.markdown.codeBlocks.theme.dark)},
      },
      defaultColor: false,
      transformers: [${twoslashTransformer}...blumeShikiTransformers(${JSON.stringify(
        { icons: config.markdown.code.icons }
      )})],
    },
  },
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss(), prerenderDepsPlugin(), serverAppResolvePlugin()],
    // The lazy client-side imports both land on CJS/UMD files: mermaid (for
    // diagrams) statically imports dayjs as CJS (\`dayjs/dayjs.min.js\`), and
    // epub-gen-memory's browser bundle is a browserified UMD. In dev, an
    // un-pre-bundled dependency is served as raw ESM, where such a file
    // exposes no \`default\` export — mermaid throws on load and diagrams
    // render blank, and the EPUB export throws \`epub is not a function\`
    // (the UMD finds no \`exports\`/\`define\` and strands its callable on
    // \`window.epubGen\` instead). Forcing them through the dep optimizer
    // restores the CJS interop. In a standalone install these dynamic imports
    // live inside \`node_modules/blume\`, which Vite's optimizer scan doesn't
    // crawl, so neither is discovered on its own — hence the explicit
    // includes. They resolve through the \`blume\` package (they aren't direct
    // deps of the generated project), so the nested \`blume > x\` form is
    // required, and epub-gen-memory must name the \`/bundle\` subpath that is
    // actually imported: optimizing the package root leaves that entry out.
    // Production (Rollup) already handles the interop, so this only affects dev.
    optimizeDeps: {
      include: ["blume > mermaid", "blume > epub-gen-memory/bundle"],
    },
    // Blume's render-time deps are forced external on both build environments so
    // native bindings resolve at runtime and isolated linkers don't bundle
    // symlinked store copies (which would surface their children as unresolvable
    // imports). See RENDER_EXTERNAL_DEPS / prerenderDepsPlugin.
    //
    // The SSR externals go through the legacy \`ssr.external\` key rather than
    // \`environments.ssr\`: defining a user-owned \`environments.ssr\` block
    // collides with the internal environment Astro 7 builds the server under and
    // detaches the adapter's server entrypoint from the rolldown input, so the
    // SSR entry is emitted as \`index.mjs\` instead of the \`entry.mjs\` the
    // Vercel adapter's \`astro:build:done\` hook then fails to find. \`prerender\`
    // is Astro-only and has no legacy equivalent, so it stays under \`environments\`.
    ssr: { external: ${JSON.stringify(RENDER_EXTERNAL_DEPS)} },
    environments: {
      prerender: { resolve: { external: ${JSON.stringify(RENDER_EXTERNAL_DEPS)} } },
    },
    resolve: {
      alias: {
        "blume:ask": ${JSON.stringify(askPath)},
        "blume:data": ${JSON.stringify(dataPath)},
        "blume:examples": ${JSON.stringify(examplesPath)},
        "blume:examples-theme": ${JSON.stringify(examplesThemePath)},
        "blume:openapi": ${JSON.stringify(openapiPath)},
        "blume:search-client": ${JSON.stringify(searchClientPath)},
        "blume:theme": ${JSON.stringify(themePath)},${userAliasLines}
      },
    },
    server: {
      fs: {
        allow: ${JSON.stringify(fsAllow)},
      },${watchOption}
    },
  },
});
`;
};

/** The default staged-content base, relative to the runtime `outDir`. */
export const stagedContentDir = (outDir: string): string =>
  join(outDir, "content");

/**
 * The runtime dir relative to the docs collection `base` when it sits inside
 * it (a migrated, `content.root: "."` project) — null when it lives elsewhere.
 * Drives both the collection's negative glob (`contentConfigTemplate`) and
 * whether the dev watcher is kept out of Astro's cache dir (the
 * `contentWatchesRuntimeDir` option of `astroConfigTemplate`).
 */
export const runtimeDirWithin = (
  base: string,
  outDir: string
): string | null => {
  const rel = relative(base, outDir);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : null;
};

/**
 * Astro's glob loader resolves `base` with `new URL(base, config.root)`. On
 * Windows an absolute path like `C:\\docs\\content` makes `new URL` parse the
 * drive letter as a URL scheme, so the result isn't a `file:` URL and Astro's
 * subsequent `fileURLToPath` throws "The URL must be of scheme file". Emit an
 * absolute base as a proper `file://` URL so the drive letter can't be mistaken
 * for a scheme; relative bases resolve against `config.root` unchanged.
 */
const astroGlobBase = (base: string): string =>
  isAbsolute(base) ? pathToFileURL(base).href : base;

/** Generate `.blume/src/content.config.ts`. */
export const contentConfigTemplate = (options: {
  context: ProjectContext;
  config: ResolvedConfig;
  /** Whether any non-filesystem source materialized MDX into the staged dir. */
  staged?: boolean;
  /** Base dir for the staged collection; defaults to `<outDir>/content`. */
  stagedBase?: string;
  /**
   * The `docs` collection's base + include/exclude globs. Defaults to
   * `content.root` and the top-level content globs; a single filesystem source
   * roots the collection at *its* root so entry ids resolve (see
   * `resolveDocsCollection`).
   */
  collection?: { base: string; include: string[]; exclude: string[] };
  /**
   * Whether any filesystem (non-staged) source feeds the `docs` collection.
   * When false (e.g. an all-staged project where every page is materialized by
   * a non-filesystem source), the collection globs nothing — see below.
   */
  filesystem?: boolean;
}): string => {
  const { context, config } = options;
  const stagedBase = options.stagedBase ?? stagedContentDir(context.outDir);
  const collectionBase = options.collection?.base ?? context.contentRoot;
  const includeGlobs = options.collection?.include ?? config.content.include;
  const excludeGlobs = options.collection?.exclude ?? config.content.exclude;

  // Fold the content excludes into the glob as negative patterns so the `docs`
  // collection doesn't ingest ignored trees (`node_modules`, `snippets`, the
  // staged bodies under `.blume/content`, …) as entries. This matters when
  // the collection base is the project root (a migrated `.`-rooted project).
  const outDirRel = runtimeDirWithin(collectionBase, context.outDir);
  const outDirIgnore = outDirRel ? [`!${outDirRel}/**`] : [];

  // With no filesystem source, no route renders through `docs`, so glob nothing.
  // Beyond skipping wasted work, this is the only thing that keeps Astro's
  // content-layer *watcher* out of `.blume/`: an all-staged project roots the
  // collection at the project dir (which contains `.blume/.astro/fonts`, rewritten on every
  // request), and the watcher's match test is `picomatch.isMatch(path, pattern)`
  // — with array-OR semantics, any `!ignored/**` negation *matches* unrelated
  // files, so negative patterns can't exclude a subtree there. An empty pattern
  // matches nothing, so the watcher stays silent. The collection is still
  // declared below so `getCollection("docs")` / `getEntry` resolve (to empty).
  const filesystem = options.filesystem ?? true;
  const docsPattern = filesystem
    ? [
        ...includeGlobs,
        ...(excludeGlobs ?? []).map((pattern) => `!${pattern}`),
        // Mirror the filesystem scan's baseline ignores (see BLUME_IGNORE_DIRS):
        // Astro's content layer roots at the project dir, so a `.`-wide content
        // root would otherwise re-ingest dependency trees and build output —
        // e.g. a prior `dist/*.mdx` render — and crash the content-module graph.
        // The runtime dir (`.blume`, or a custom distDir) is excluded precisely
        // by `outDirIgnore` instead, so it's left out of this baseline.
        ...BLUME_IGNORE_DIRS.flatMap((dir) =>
          dir === ".blume" ? [] : [`!**/${dir}/**`]
        ),
        ...outDirIgnore,
      ]
    : [];

  // Non-filesystem sources render through a parallel `staged` collection backed
  // by materialized MDX, so the filesystem `docs` collection stays untouched.
  const stagedBlock = options.staged
    ? `
const staged = defineCollection({
  loader: glob({
    pattern: ["**/*.{md,mdx}"],
    base: ${JSON.stringify(astroGlobBase(stagedBase))},
    generateId: ({ entry }) => entry,
  }),
});
`
    : "";

  return `// Generated by Blume. Do not edit.
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

const docs = defineCollection({
  loader: glob({
    pattern: ${JSON.stringify(docsPattern)},
    base: ${JSON.stringify(astroGlobBase(collectionBase))},
    generateId: ({ entry }) => entry,
  }),
});
${stagedBlock}
export const collections = { docs${options.staged ? ", staged" : ""} };
`;
};

/** Generate `.blume/src/pages/[...slug].astro`, the docs catch-all route. */
/** Generate the Ask AI server endpoint (`.blume/src/pages/api/ask.ts`). */
export const askEndpointTemplate = (
  backend: AskBackend,
  grounded: boolean
): string => {
  const imports = [
    'import type { APIRoute } from "astro";',
    'import { streamText } from "ai";',
  ];
  let setup = "";
  let modelExpr = JSON.stringify(backend.model);
  if (backend.kind === "openrouter") {
    imports.push(
      'import { createOpenRouter } from "@openrouter/ai-sdk-provider";'
    );
    setup = `\nconst openrouter = createOpenRouter({ apiKey: process.env[${JSON.stringify(
      backend.apiKeyEnv
    )}] });\n`;
    modelExpr = `openrouter(${JSON.stringify(backend.model)})`;
  } else if (backend.kind === "openai-compatible") {
    imports.push(
      'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";'
    );
    setup = `\nconst provider = createOpenAICompatible({
  apiKey: process.env[${JSON.stringify(backend.apiKeyEnv)}],
  baseURL: ${JSON.stringify(backend.baseUrl)},
  name: ${JSON.stringify(backend.name)},
});\n`;
    modelExpr = `provider(${JSON.stringify(backend.model)})`;
  }
  // Ground the answer in retrieved docs, except for RAG-native backends (Inkeep),
  // which run their own retrieval and would conflict with injected context.
  if (grounded) {
    imports.push(
      'import { createAskContext } from "blume/ai/ask-context.ts";',
      'import askData from "../../generated/ask-data.json";'
    );
    setup += "\nconst ground = createAskContext(askData);\n";
  }
  // Validate the client-supplied body and cap its size. The endpoint is
  // unauthenticated, so bounding message count/length limits how much a caller
  // can spend against the model per request, and restricting roles to
  // user/assistant keeps callers from injecting their own system prompt and
  // repurposing the endpoint as a general LLM proxy; front it with a rate
  // limiter (or your provider's limits) for stronger protection.
  const validate = `  const body = await request.json().catch(() => null);
  const raw = body?.messages;
  const valid =
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.length <= 40 &&
    raw.every(
      (m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        ("role" in m && (m.role === "user" || m.role === "assistant")) &&
        ("content" in m && typeof m.content === "string")
    ) &&
    JSON.stringify(raw).length <= 24_000;
  if (!valid) {
    return new Response(
      "Invalid request: send 1-40 user/assistant messages with string content.",
      { status: 400 }
    );
  }
  // Re-build the array so only role/content ever reach the model.
  const messages = raw.map((m: { role: "user" | "assistant"; content: string }) => ({
    content: m.content,
    role: m.role,
  }));`;
  // `streamText` returns synchronously and defers provider/auth/network errors
  // to stream consumption, so the handler's try/catch never sees them: without
  // these the client gets a 200 whose stream aborts mid-flight and nothing is
  // logged server-side. A missing credential is rejected up front as a real
  // 500; everything else is at least logged via `onError`.
  const keyCheck =
    backend.kind === "gateway"
      ? `  // The AI Gateway authenticates with an API key or Vercel's OIDC token.
  if (!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN)) {
    return new Response(
      "Ask AI is not configured: set AI_GATEWAY_API_KEY (or deploy on Vercel with OIDC).",
      { status: 500 }
    );
  }`
      : `  if (!process.env[${JSON.stringify(backend.apiKeyEnv)}]) {
    return new Response(
      ${JSON.stringify(`Ask AI is not configured: set ${backend.apiKeyEnv}.`)},
      { status: 500 }
    );
  }`;
  // Provider errors surface mid-stream, after the 200 is committed; this is
  // the only place they can be observed server-side.
  const onError = `      onError({ error }) {
        console.error("Ask AI provider error:", error);
      },`;
  const stream = grounded
    ? `    const system =
      (await ground(messages, body.page)) ??
      "You are a helpful documentation assistant. Answer using the project's documentation.";
    const result = streamText({
      model: ${modelExpr},
      system,
      messages,
${onError}
    });`
    : `    const result = streamText({
      model: ${modelExpr},
      system:
        "You are a helpful documentation assistant. Answer using the project's documentation.",
      messages,
${onError}
    });`;
  const handler = `export const POST: APIRoute = async ({ request }) => {
${validate}
${keyCheck}
  try {
${stream}
    return result.toTextStreamResponse();
  } catch {
    return new Response("Failed to generate a response.", { status: 500 });
  }
};`;
  return `// Generated by Blume. Do not edit.
${imports.join("\n")}

export const prerender = false;
${setup}
${handler}
`;
};

/**
 * Generate `.blume/src/generated/Ask.astro` — the component behind the
 * `blume:ask` alias that the shared header renders in place of a per-page slot.
 *
 * The header can't import the Ask AI island directly: it's a React component, so
 * the import alone would drag the JSX renderer into the module graph of every
 * project — including the ones that never enable Ask AI and therefore have no
 * React integration wired into their generated Astro config (see `needsReact`).
 * Routing the import through a generated component keeps that dependency behind
 * the config switch: enabled projects get the island, disabled ones get a
 * component that renders nothing and imports no React.
 *
 * `strings` comes from the header (the active locale's dictionary); the empty-
 * state suggestions are read straight from the data snapshot, which is why no
 * page has to pass them.
 */
export const askComponentTemplate = (askEnabled: boolean): string =>
  askEnabled
    ? `---
// Generated by Blume. Do not edit.
import AskAI from "blume/components/islands/AskAI.astro";
import data from "blume:data";

const { strings } = Astro.props;
---

<AskAI strings={strings ?? data.ui.ask} suggestions={data.config.ask?.suggestions ?? []} />
`
    : `---
// Generated by Blume. Do not edit.
// Ask AI is off (\`ai.ask.enabled\`), so the header's Ask trigger renders nothing.
// Deliberately imports no React island, keeping the JSX renderer out of projects
// that don't need it.
---
`;

/** Generate the static search index endpoint (`/blume-search.json`). */
export const searchEndpointTemplate = (): string =>
  `// Generated by Blume. Do not edit.
import documents from "../generated/search.json";

export const prerender = true;

export function GET() {
  return new Response(JSON.stringify(documents), {
    headers: { "Content-Type": "application/json" },
  });
}
`;

const SEARCH_CLIENT_HEADER = "// Generated by Blume. Do not edit.\n";

/** Import the chosen provider's `createSearch` from the Blume package. */
const searchClientImport = (module: string): string =>
  `import { createSearch as create } from "blume/components/layout/search/${module}.ts";\n`;

// Joins a base-relative path onto BASE_URL, which arrives with or without a
// trailing slash (Astro's default trailingSlash: "ignore" passes `/docs`
// through bare — naive concatenation would yield `/docsblume-search.json`).
const SEARCH_BASE_IMPORT =
  'import { joinBase } from "blume/components/islands/base-path.ts";\n';

/** A client that loads a static `blume-search.json` index (Orama, FlexSearch). */
const staticSearchClient = (module: string): string =>
  `${SEARCH_CLIENT_HEADER}${searchClientImport(module)}${SEARCH_BASE_IMPORT}
const indexUrl = joinBase(import.meta.env.BASE_URL, "blume-search.json");

export const createSearch = () => create({ indexUrl });
`;

/** A client that passes public credentials straight to the provider SDK. */
const hostedSearchClient = (
  module: string,
  options: Record<string, unknown>
): string =>
  `${SEARCH_CLIENT_HEADER}${searchClientImport(module)}
export const createSearch = () => create(${JSON.stringify(options)});
`;

/** Build the per-provider config object the hosted client is created with. */
const hostedSearchOptions = (
  search: ResolvedConfig["search"]
): { module: string; options: Record<string, unknown> } | null => {
  switch (search.provider) {
    case "algolia": {
      return { module: "algolia", options: { ...search.algolia } };
    }
    case "orama-cloud": {
      return {
        module: "orama-cloud",
        options: {
          apiKey: search.oramaCloud?.apiKey,
          endpoint: search.oramaCloud?.endpoint,
        },
      };
    }
    case "typesense": {
      return { module: "typesense", options: { ...search.typesense } };
    }
    default: {
      return null;
    }
  }
};

/**
 * Generate `.blume/src/generated/search-client.ts` — the provider-specific
 * loader the `<Search>` component lazy-imports via the `blume:search-client`
 * alias. Only the configured provider's module (and therefore its SDK) is
 * referenced, so the build bundles exactly one backend. Public credentials are
 * baked in here; secret keys never reach the client.
 */
export const searchClientTemplate = (config: ResolvedConfig): string => {
  const { search } = config;

  if (search.provider === "orama" || search.provider === "flexsearch") {
    return staticSearchClient(search.provider);
  }

  const hosted = hostedSearchOptions(search);
  if (hosted) {
    return hostedSearchClient(hosted.module, hosted.options);
  }

  if (search.provider === "mixedbread") {
    return `${SEARCH_CLIENT_HEADER}${searchClientImport("endpoint")}${SEARCH_BASE_IMPORT}
const api = joinBase(import.meta.env.BASE_URL, "api/search");

export const createSearch = () => create({ api });
`;
  }

  if (search.provider === "pagefind") {
    return `${SEARCH_CLIENT_HEADER}${searchClientImport("pagefind")}${SEARCH_BASE_IMPORT}
const url = joinBase(import.meta.env.BASE_URL, "pagefind/pagefind.js");

export const createSearch = () => create({ url });
`;
  }

  // Search disabled: a no-op client so the alias always resolves.
  return `${SEARCH_CLIENT_HEADER}export const createSearch = () => () =>
  Promise.resolve({ hits: [], sections: [] });
`;
};

/**
 * Generate the Mixedbread search endpoint (`/api/search`). It holds the secret
 * key server-side and proxies semantic queries to the configured store. The
 * result mapping is best-effort and may need tuning to how your content was
 * synced (see the Mixedbread sync step / \`mxbai vs sync\`).
 */
export const mixedbreadSearchEndpointTemplate = (storeId: string): string =>
  `// Generated by Blume. Do not edit.
import type { APIRoute } from "astro";
import Mixedbread from "@mixedbread/sdk";

export const prerender = false;

const client = new Mixedbread({ apiKey: process.env.MIXEDBREAD_API_KEY ?? "" });
const STORE_ID = ${JSON.stringify(storeId)};

export const POST: APIRoute = async ({ request }) => {
  // The endpoint is public: a malformed body must 200-empty, not 500.
  const body = await request.json().catch(() => null);
  const query = body?.query;
  if (!query || typeof query !== "string") {
    return new Response("[]", {
      headers: { "Content-Type": "application/json" },
    });
  }
  const response = await client.stores.search({
    query,
    store_identifiers: [STORE_ID],
    top_k: 8,
  });
  const hits = (response.data ?? []).map((chunk) => {
    const meta = chunk.generated_metadata ?? {};
    return {
      excerpt: chunk.text ?? meta.excerpt ?? "",
      title: meta.title ?? chunk.filename ?? "",
      url: meta.url ?? "",
    };
  });
  return new Response(JSON.stringify(hits), {
    headers: { "Content-Type": "application/json" },
  });
};
`;

/**
 * Generate the raw-Markdown endpoints (`[...slug].md.ts` and `[...slug].mdx.ts`).
 * Both read `raw-markdown.json`, whose entries hold the verbatim source (`mdx`)
 * plus a component-downleveled variant (`md`) when the page uses components:
 * `/<route>.mdx` serves the source exactly as written, `/<route>.md` serves
 * plain Markdown with `<TypeTable>`-style components converted for consumers
 * that can't interpret JSX.
 */
export const rawMarkdownEndpointTemplate = (kind: "md" | "mdx"): string =>
  `// Generated by Blume. Do not edit.
import raw from "../generated/raw-markdown.json";

export const prerender = true;

export function getStaticPaths() {
  return Object.keys(raw).map((route) => ({
    params: { slug: route === "/" ? "index" : route.slice(1) },
    props: { route },
  }));
}

export function GET({ props }: { props: { route: string } }) {
  const entries = raw as Record<string, { md?: string; mdx?: string }>;
  const entry = entries[props.route];
  return new Response(entry ? ${
    kind === "md" ? '(entry.md ?? entry.mdx ?? "")' : '(entry.mdx ?? "")'
  } : "", {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
`;

/** The `src/pages` file that serves a route, e.g. `/mcp` -> `mcp.ts`. */
export const mcpPageFile = (route: string): string =>
  `${trimChar(route, "/")}.ts`;

/**
 * Generate the hosted MCP server endpoint (e.g. `.blume/src/pages/mcp.ts`). A
 * thin wrapper around the shipped `createMcpFetchHandler`, served from the
 * generated data snapshot. Runs server-side (no prerender) so agents can query
 * the docs over Streamable HTTP.
 */
export const mcpEndpointTemplate = (route: string): string => {
  const clean = trimChar(route, "/");
  const up = "../".repeat(clean.split("/").length);
  return `// Generated by Blume. Do not edit.
import type { APIRoute } from "astro";
import { createMcpFetchHandler } from "blume/ai/mcp/server.ts";
import data from "${up}generated/mcp-data.json";

export const prerender = false;

const handler = createMcpFetchHandler(data);

export const ALL: APIRoute = ({ request }) => handler(request);
`;
};

/** Generate a prerendered endpoint that serves a fixed JSON payload. */
export const staticJsonEndpointTemplate = (payload: unknown): string =>
  `// Generated by Blume. Do not edit.
export const prerender = true;

const payload = ${JSON.stringify(payload, null, 2)};

export function GET() {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
}
`;

/**
 * Generate the RSS endpoint (`[section]/rss.xml.ts`). One feed per content
 * type is served from the generated `rss.json`, e.g. `/blog/rss.xml`.
 */
export const rssEndpointTemplate = (): string =>
  `// Generated by Blume. Do not edit.
import feeds from "../../generated/rss.json";

export const prerender = true;

export function getStaticPaths() {
  return Object.keys(feeds).map((section) => ({
    params: { section },
    props: { section },
  }));
}

export function GET({ props }: { props: { section: string } }) {
  const bySection = feeds as Record<string, string>;
  return new Response(bySection[props.section] ?? "", {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
`;

/** Generate the OG image endpoint (`.blume/src/pages/_og/[...slug].png.ts`). */
export const ogEndpointTemplate = (
  customRoutes: OgCustomRoute[] = []
): string =>
  `// Generated by Blume. Do not edit.
import { renderOgImage } from "blume/og";
import data from "blume:data";

export const prerender = true;

// Custom (non-content) pages opted into a generated card, baked in at build.
// The annotation keeps the empty-array case from being an implicit any[]
// (ts(7034)) under a strict tsconfig.
const customRoutes: { slug: string; title: string }[] = ${JSON.stringify(customRoutes)};

export function getStaticPaths() {
  const seen = new Set<string>();
  const paths: { params: { slug: string }; props: { title: string } }[] = [];
  const add = (slug: string, title: string) => {
    if (seen.has(slug)) {
      return;
    }
    seen.add(slug);
    paths.push({ params: { slug }, props: { title } });
  };
  // A custom page wins over a content route sharing its path, so add it first.
  for (const route of customRoutes) {
    add(route.slug, route.title);
  }
  for (const route of data.routes) {
    add(route.path === "/" ? "index" : route.path.slice(1), route.title);
  }
  return paths;
}

// Footer branding shared by every card, derived once from the resolved config.
// The repo slug reuses the header link URL; the host comes from the site URL.
const repoSlug = data.config.repoUrl
  ? data.config.repoUrl.split("github.com/")[1]
  : undefined;
const siteHost = (() => {
  if (!data.config.site) {
    return undefined;
  }
  try {
    return new URL(data.config.site).host;
  } catch {
    return undefined;
  }
})();

export async function GET({ props }: { props: { title: string } }) {
  const png = await renderOgImage({
    accent: data.config.og.palette?.accent ?? data.config.theme.accent.light,
    brand: data.config.title,
    description: data.config.description,
    fonts: data.config.og.fonts,
    logo: data.config.og.logo,
    palette: data.config.og.palette,
    repo: repoSlug,
    site: siteHost,
    title: props.title,
  });
  return new Response(new Uint8Array(png), {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "image/png",
    },
  });
}
`;

/**
 * Generate a Scalar API/AsyncAPI reference page (`.blume/src/pages/<route>.astro`).
 * The reference UI is owned by Scalar (its standalone bundle, loaded from a CDN)
 * but mounted inside Blume's {@link ReferenceLayout} so the page keeps Blume's
 * navbar on top. `renderMode: "client"` mounts the reference into a container
 * element (rather than emitting a full HTML document), which is what lets it
 * live inside our shell. `dataImport` is the route-depth-aware relative path to
 * the generated data module the layout reads.
 */
export const scalarReferenceTemplate = (options: {
  configuration: Record<string, unknown>;
  dataImport: string;
  route: string;
  title: string;
}): string =>
  `---
// Generated by Blume. Do not edit.
import { ScalarComponent } from "@scalar/astro";
import ReferenceLayout from "blume/components/layout/ReferenceLayout.astro";
import data from ${JSON.stringify(options.dataImport)};

export const prerender = true;

const configuration = ${JSON.stringify(options.configuration, null, 2)};

// The reference is an unlocalized route, so its chrome renders in the default
// locale's language and direction (\`data.ui\` is the default locale's resolved
// dictionary), mirroring the changelog index's locale wiring.
const i18n = data.config.i18n;
const localeMeta = i18n
  ? i18n.locales.find((l) => l.code === i18n.defaultLocale)
  : null;
const dir = localeMeta?.dir ?? "ltr";
const htmlLang = i18n ? i18n.defaultLocale : "en";
---

<ReferenceLayout
  analytics={data.config.analytics}
  banner={data.config.banner}
  dir={dir}
  fontCssVars={data.fontCssVars}
  locale={htmlLang}
  logo={data.config.logo}
  favicon={data.config.favicon}
  appleIcon={data.config.appleIcon}
  navigation={data.navigation}
  pageTitle={${JSON.stringify(options.title)}}
  route={${JSON.stringify(options.route)}}
  searchEnabled={data.config.search.enabled}
  site={{ title: data.config.title, description: data.config.description }}
  themeMode={data.config.theme.mode}
  ui={data.ui}
>
  <ScalarComponent configuration={configuration} renderMode="client" />
</ReferenceLayout>
`;

export const catchAllPageTemplate = (options: {
  exportEpub: boolean;
  exportPdf: boolean;
  mathEnabled: boolean;
  /** Serialize the island-hooks snapshot; only needed when React is enabled. */
  needsReact: boolean;
}): string => {
  const mathImport = options.mathEnabled
    ? 'import Math from "blume/components/content/Math.astro";\n'
    : "";
  const mathEntry = options.mathEnabled ? "Math,\n  " : "";
  // The island-hooks snapshot (config + navigation + page) for `blume/hooks`.
  const clientData = options.needsReact
    ? "\n  clientData={{ config: data.config, navigation, page: { route, title: seo.title ?? title } }}"
    : "";

  return `---
// Generated by Blume. Do not edit.
import { getEntry, render } from "astro:content";
import type { CollectionKey } from "astro:content";
import RootLayout from "blume/components/layout/RootLayout.astro";
import { withBase } from "blume/components/islands/base-path.ts";
import { resolveSlot } from "blume/components/layout/overrides.ts";
import Accordion from "blume/components/content/Accordion.astro";
import AccordionItem from "blume/components/content/AccordionItem.astro";
import AutoTypeTable from "blume/components/content/AutoTypeTable.astro";
import Badge from "blume/components/content/Badge.astro";
import Callout from "blume/components/content/Callout.astro";
import Card from "blume/components/content/Card.astro";
import CardGroup from "blume/components/content/CardGroup.astro";
import CodeBlock from "blume/components/content/CodeBlock.astro";
import CodeGroup from "blume/components/content/CodeGroup.astro";
import ColorRoot from "blume/components/content/Color.astro";
import ColorItem from "blume/components/content/ColorItem.astro";
import ColorRow from "blume/components/content/ColorRow.astro";
import Column from "blume/components/content/Column.astro";
import Columns from "blume/components/content/Columns.astro";
import Component from "blume/components/content/Component.astro";
import Diff from "blume/components/content/Diff.astro";
import Expandable from "blume/components/content/Expandable.astro";
import FileTree from "blume/components/content/FileTree.astro";
import Frame from "blume/components/content/Frame.astro";
import GithubInfo from "blume/components/content/GithubInfo.astro";
import Panel from "blume/components/content/Panel.astro";
import Prompt from "blume/components/content/Prompt.astro";
import Step from "blume/components/content/Step.astro";
import Steps from "blume/components/content/Steps.astro";
import Tab from "blume/components/content/Tab.astro";
import Tabs from "blume/components/content/Tabs.astro";
import Tile from "blume/components/content/Tile.astro";
import Tooltip from "blume/components/content/Tooltip.astro";
import TreeRoot from "blume/components/content/Tree.astro";
import TreeFile from "blume/components/content/TreeFile.astro";
import TreeFolder from "blume/components/content/TreeFolder.astro";
import TypeTable from "blume/components/content/TypeTable.astro";
import Visibility from "blume/components/content/Visibility.astro";
import YouTube from "blume/components/content/YouTube.astro";
import Icon from "blume/components/Icon.astro";
import ApiOverview from "blume/components/openapi/ApiOverview.astro";
import ApiTagOperations from "blume/components/openapi/ApiTagOperations.astro";
import Operation from "blume/components/openapi/Operation.astro";
${mathImport}import { mdxComponents as userMdx, layoutOverrides } from "../generated/components.ts";
import { islandComponents } from "../generated/islands.ts";
import data from "blume:data";

const Color = Object.assign(ColorRoot, { Item: ColorItem, Row: ColorRow });
const Tree = Object.assign(TreeRoot, { File: TreeFile, Folder: TreeFolder });

// Docs content is file-based and always prerendered, even in server output
// (where only endpoints like /api/ask render on demand). Without this, server
// builds would render this route on demand and ignore getStaticPaths, leaving
// the entry id undefined.
export const prerender = true;

const components = {
  Accordion,
  AccordionItem,
  ApiOverview,
  ApiTagOperations,
  AutoTypeTable,
  Badge,
  Callout,
  Card,
  CardGroup,
  CodeBlock,
  CodeGroup,
  Color,
  Column,
  Columns,
  Component,
  Diff,
  Expandable,
  FileTree,
  Frame,
  GithubInfo,
  Icon,
  Operation,
  Panel,
  Prompt,
  Step,
  Steps,
  Tab,
  Tabs,
  Tile,
  Tooltip,
  Tree,
  TypeTable,
  Visibility,
  YouTube,
  ${mathEntry}...islandComponents,
  ...userMdx,
};

export function getStaticPaths() {
  return data.routes.map((route) => ({
    params: { slug: route.path === "/" ? undefined : route.path.slice(1) },
    props: {
      alternates: route.alternates,
      collection: route.collection,
      editUrl: route.editUrl,
      entryId: route.entryId,
      fallback: route.fallback,
      indexable: route.indexable,
      lastModified: route.lastModified,
      locale: route.locale,
      route: route.path,
      title: route.title,
    },
  }));
}

const { entryId, collection, route, title, indexable, editUrl, lastModified, locale, alternates, fallback } = Astro.props;
const entry = await getEntry(collection as CollectionKey, entryId);
if (!entry) {
  return new Response(null, { status: 404 });
}
const { Content, headings } = await render(entry);
const frontmatter = entry.data ?? {};

const seo = frontmatter.seo ?? {};
const base = data.config.site ? data.config.site.replace(/\\/$/, "") : null;

const ogPath = data.config.og.enabled
  ? \`/og/\${route === "/" ? "index" : route.slice(1)}.png\`
  : null;
const ogRel = seo.image ?? ogPath;
// Absolute URLs also carry the deployment base (the page is served under it):
// \`site + base + path\`. Only absolutize root-relative paths: \`seo.image\` may be
// an external URL, which passes through verbatim (mirrors PageLayout).
const ogImage =
  ogRel && base && ogRel.startsWith("/") ? \`\${base}\${withBase(ogRel)}\` : ogRel;
// Blume's generated card has known dimensions the layout can declare; a user's
// \`seo.image\` could be any size or format, so it gets none.
const ogGenerated = !seo.image && Boolean(ogPath);

// X attribution: the site's account, plus a creator the page can claim for
// itself (a guest post crediting its own author) over the configured default.
const x = { ...data.config.x, ...(seo.x?.creator ? { creator: seo.x.creator } : {}) };

const basedRoute = withBase(route);
const canonical =
  seo.canonical ??
  (base ? \`\${base}\${basedRoute === "/" ? "" : basedRoute}\` : null);

// Locale resolution. With i18n on, pick the active locale's nav + dictionary,
// build hreflang alternates, and derive the language-switcher targets.
const i18n = data.config.i18n;
const localePrefix = (codeArg: string) =>
  i18n && codeArg === i18n.defaultLocale && i18n.hideDefaultLocalePrefix
    ? ""
    : \`/\${codeArg}\`;
const localizeRoute = (logical: string, codeArg: string) => {
  const prefix = localePrefix(codeArg);
  if (!prefix) {
    return logical;
  }
  return logical === "/" ? prefix : \`\${prefix}\${logical}\`;
};
const stripLocale = (path: string, codeArg: string) => {
  const prefix = localePrefix(codeArg);
  return prefix && path.startsWith(prefix) ? path.slice(prefix.length) || "/" : path;
};

const navigation = i18n ? (data.navigationByLocale[locale] ?? data.navigation) : data.navigation;
const ui = i18n ? (data.uiByLocale[locale] ?? data.ui) : data.ui;
const localeMeta = i18n ? i18n.locales.find((l) => l.code === locale) : null;
const dir = localeMeta?.dir ?? "ltr";
const htmlLang = i18n ? locale : "en";
// A fallback page renders the fallback locale's content, so its text direction
// follows that language — not the (mirrored) page locale.
const contentLocale =
  fallback && i18n?.fallbackLocale ? i18n.fallbackLocale : locale;
const contentDir = i18n
  ? (i18n.locales.find((l) => l.code === contentLocale)?.dir ?? "ltr")
  : "ltr";
const absolute = (path: string) => {
  const p = withBase(path);
  return base + (p === "/" ? "" : p);
};

const localeAlternates =
  i18n && base
    ? (alternates ?? []).map((alt) => ({ hreflang: alt.locale, href: absolute(alt.path) }))
    : [];
const defaultAlt = i18n ? (alternates ?? []).find((alt) => alt.locale === i18n.defaultLocale) : null;
const xDefault = defaultAlt && base ? absolute(defaultAlt.path) : null;

const logicalRoute = i18n ? stripLocale(route, locale) : route;
const localeSwitch = i18n
  ? i18n.locales.map((l) => {
      const alt = (alternates ?? []).find((x) => x.locale === l.code);
      return {
        code: l.code,
        current: l.code === locale,
        dir: l.dir,
        href: alt ? alt.path : localizeRoute(logicalRoute, l.code),
        label: l.label,
        untranslated: !alt,
      };
    })
  : [];

// The whole page shell is overridable via \`layout.Layout\`; it receives the same
// props as the built-in RootLayout, plus the \`layout\` map for its inner slots.
const LayoutComponent = resolveSlot(layoutOverrides.Layout, RootLayout);
---

<LayoutComponent
  site={{ title: data.config.title, description: data.config.description }}
  layout={layoutOverrides}${clientData}
  logo={data.config.logo}
  mcp={data.config.mcp}
  favicon={data.config.favicon}
  appleIcon={data.config.appleIcon}
  banner={data.config.banner}
  analytics={data.config.analytics}
  imageZoom={data.config.imageZoom}
  codeWrap={data.config.codeWrap}
  navigation={navigation}
  locale={htmlLang}
  dir={dir}
  contentDir={contentDir}
  ui={ui}
  localeAlternates={localeAlternates}
  xDefault={xDefault}
  localeSwitch={localeSwitch}
  page={{ title: seo.title ?? title, description: seo.description ?? frontmatter.description, route }}
  headings={headings}
  toc={data.config.toc}
  dateFormat={data.config.dateFormat}
  themeMode={data.config.theme.mode}
  fontCssVars={data.fontCssVars}
  searchEnabled={data.config.search.enabled}
  indexable={indexable}
  ogImage={ogImage}
  ogGenerated={ogGenerated}
  x={x}
  canonical={canonical}
  editUrl={editUrl}
  feedback={data.config.feedback}
  exportPdf={${options.exportPdf}}
  exportEpub={${options.exportEpub}}
  feeds={data.feeds}
  siteUrl={data.config.site}
  pageType={frontmatter.type}
  published={frontmatter.date ?? frontmatter.changelog?.date ?? null}
  lastModified={lastModified}
  noindex={seo.noindex}
  structuredDataEnabled={data.config.structuredData}
>
  <h1>{title}</h1>
  {frontmatter.description && <p class="text-lg text-muted-foreground">{frontmatter.description}</p>}
  <Content components={components} />
</LayoutComponent>
`;
};

/**
 * Generate `.blume/src/pages/changelog.astro` — the changelog index. Collects
 * every `type: changelog` entry, sorts newest-first, and renders each through
 * the `Update` timeline layout (date/version rail + entry content). Only written
 * by {@link generateAstroProject} when changelog entries exist.
 */
export const changelogIndexTemplate = (options: {
  exportEpub: boolean;
  exportPdf: boolean;
  /** Serialize the island-hooks snapshot; only needed when React is enabled. */
  needsReact: boolean;
  /** Whether a `staged` collection exists (non-filesystem changelog sources). */
  staged: boolean;
}): string => {
  const clientData = options.needsReact
    ? '\n  clientData={{ config: data.config, navigation: data.navigation, page: { route: "/changelog", title: pageTitle } }}'
    : "";
  // Staged sources (e.g. GitHub Releases) render through a parallel collection,
  // so fold them in alongside filesystem entries when one exists.
  const stagedSpread = options.staged
    ? '\n  ...(await getCollection("staged")),'
    : "";

  return `---
// Generated by Blume. Do not edit.
import { getCollection, render } from "astro:content";
import RootLayout from "blume/components/layout/RootLayout.astro";
import Update from "blume/components/content/Update.astro";
import { withBase } from "blume/components/islands/base-path.ts";
import { resolveSlot } from "blume/components/layout/overrides.ts";
import { resolveDateFormatOptions } from "blume/core/date-format.ts";
import { layoutOverrides } from "../generated/components.ts";
import data from "blume:data";

export const prerender = true;

const entryDate = (entry: {
  data: { date?: string | null; changelog?: { date?: string | null } | null };
}) => entry.data.date ?? entry.data.changelog?.date ?? null;

const toTime = (value: string | null | undefined) => {
  if (!value) {
    return 0;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
};

// The changelog is an unlocalized route, so its chrome renders in the default
// locale's dictionary and direction (\`data.ui\` is the default locale's resolved
// dictionary), mirroring the catch-all's locale wiring.
const i18n = data.config.i18n;
const localeMeta = i18n
  ? i18n.locales.find((l) => l.code === i18n.defaultLocale)
  : null;
const dir = localeMeta?.dir ?? "ltr";
const htmlLang = i18n ? i18n.defaultLocale : "en";

// Formatted in the same locale as the chrome, and with the configured
// \`dateFormat\` (UTC by default), to match the per-page "last updated" stamp.
const dateFormatOptions = resolveDateFormatOptions(data.config.dateFormat);
const formatDate = (value: string | null | undefined) => {
  if (!value) {
    return;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? undefined
    : new Intl.DateTimeFormat(htmlLang, dateFormatOptions).format(date);
};

const slugify = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
  "update";

// The major of a version's embedded semver (\`1.2.3\` -> 1, \`pkg@2.0.0\` -> 2), or
// null when there is no full major.minor.patch to key on. Drives the changelog's
// group-by-major pagination, so it tolerates the scoped tags monorepos publish.
const majorVersion = (version: string | null | undefined) => {
  const match = /(\\d+)\\.\\d+\\.\\d+/.exec(String(version ?? ""));
  return match ? Number(match[1]) : null;
};

// Map each entry to its own generated page so the timeline heading can deep-link
// to it. The collection entry id matches the route manifest's \`entryId\`.
const routeByEntry = new Map(
  data.routes.map((route) => [route.entryId, route.path])
);

const changelogEntries = [
  ...(await getCollection("docs")),${stagedSpread}
]
  .filter(
    (entry) =>
      entry.data.type === "changelog" &&
      !entry.data.draft &&
      !entry.data.sidebar?.hidden
  )
  .toSorted((a, b) => toTime(entryDate(b)) - toTime(entryDate(a)));

const items = await Promise.all(
  changelogEntries.map(async (entry) => {
    const label =
      entry.data.title ??
      (entry.data.changelog?.version
        ? "v" + entry.data.changelog.version
        : "Update");
    return {
      Content: (await render(entry)).Content,
      date: formatDate(entryDate(entry)),
      href: routeByEntry.get(entry.id) ?? undefined,
      id: slugify(label),
      label,
      major: majorVersion(entry.data.changelog?.version),
      tags: entry.data.changelog?.category
        ? [entry.data.changelog.category]
        : [],
    };
  })
);

// Repeated labels slug to the same id (e.g. two entries with neither a title
// nor a version both falling back to "update"); suffix the later ones -2, -3,
// ... so every heading deep-links to its own entry. The first keeps the plain
// slug, and the rendered ids stay in lockstep with the \`headings\` list below.
const seenIds = new Set();
for (const item of items) {
  let uniqueId = item.id;
  for (let n = 2; seenIds.has(uniqueId); n += 1) {
    uniqueId = item.id + "-" + n;
  }
  seenIds.add(uniqueId);
  item.id = uniqueId;
}

// A changelog is semver-paginated only when every visible release parses as
// semver and they span more than one major line. Older majors then collapse
// into groups the reader reveals one at a time; otherwise the timeline is flat.
const majors = items.every((item) => item.major !== null)
  ? [...new Set(items.map((item) => item.major))]
      .filter((major): major is number => major !== null)
      .toSorted((a, b) => b - a)
  : [];
const paginate = majors.length > 1;
const majorGroups = majors.map((major) => ({
  items: items.filter((item) => item.major === major),
  label: major + ".x",
  major,
}));

const headings = items.map((item) => ({
  depth: 2,
  slug: item.id,
  text: item.label,
}));

const base = data.config.site ? data.config.site.replace(/\\/$/, "") : null;
// The canonical URL carries the deployment base (the page is served under it),
// matching how the catch-all canonicalizes via \`withBase(route)\`.
const basedRoute = withBase("/changelog");
const canonical = base ? base + basedRoute : null;

// The page chrome (h1, title, description) comes from the same translatable
// \`changelog\` group as the reveal button; optional chaining tolerates a
// not-yet-regenerated data snapshot from before these keys existed.
const changelogTitle = data.ui.changelog?.title ?? "Changelog";
const changelogDescription =
  data.ui.changelog?.description ??
  "Product updates, new features, and fixes from every release.";
const pageTitle = data.config.title + " " + changelogTitle;

const LayoutComponent = resolveSlot(layoutOverrides.Layout, RootLayout);
---

<LayoutComponent
  site={{ title: data.config.title, description: data.config.description }}
  layout={layoutOverrides}${clientData}
  logo={data.config.logo}
  mcp={data.config.mcp}
  favicon={data.config.favicon}
  appleIcon={data.config.appleIcon}
  banner={data.config.banner}
  analytics={data.config.analytics}
  imageZoom={data.config.imageZoom}
  codeWrap={data.config.codeWrap}
  navigation={data.navigation}
  locale={htmlLang}
  dir={dir}
  ui={data.ui}
  page={{
    title: pageTitle,
    description: changelogDescription,
    route: "/changelog",
  }}
  headings={headings}
  toc={data.config.toc}
  contentLayout="bare"
  themeMode={data.config.theme.mode}
  fontCssVars={data.fontCssVars}
  searchEnabled={data.config.search.enabled}
  indexable={true}
  ogImage={null}
  x={data.config.x}
  canonical={canonical}
  exportPdf={${options.exportPdf}}
  exportEpub={${options.exportEpub}}
  feeds={data.feeds}
  siteUrl={data.config.site}
  noindex={false}
  structuredDataEnabled={data.config.structuredData}
>
  <h1>{changelogTitle}</h1>
  {
    items.length === 0 ? (
      <p>No changelog entries yet.</p>
    ) : paginate ? (
      <blume-changelog
        class="not-prose mt-8 block"
        data-i18n-more={data.ui.changelog?.showReleases}
      >
        {majorGroups[0].items.map(({ Content, href, id, label, date, tags }) => (
          <Update description={date} href={href} id={id} label={label} tags={tags}>
            <Content />
          </Update>
        ))}
        {majorGroups.slice(1).map((group) => (
          <section
            aria-label={group.label + " releases"}
            data-changelog-label={group.label}
            data-changelog-major={group.major}
          >
            {group.items.map(({ Content, href, id, label, date, tags }) => (
              <Update description={date} href={href} id={id} label={label} tags={tags}>
                <Content />
              </Update>
            ))}
          </section>
        ))}
        <div class="mt-10 flex justify-center">
          <button
            class="inline-flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 font-medium text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
            data-changelog-more
            hidden
            type="button"
          >
            Show older releases
          </button>
        </div>
      </blume-changelog>
    ) : (
      <div class="not-prose mt-8">
        {items.map(({ Content, href, id, label, date, tags }) => (
          <Update description={date} href={href} id={id} label={label} tags={tags}>
            <Content />
          </Update>
        ))}
      </div>
    )
  }
  <script>
    import "blume/components/content/changelog-element.ts";
  </script>
</LayoutComponent>
`;
};

/**
 * Generate `.blume/src/pages/404.astro`: the default not-found page. Rendered
 * through `PageLayout` (header + search, no sidebar) so it stays consistent with
 * the rest of the site, with copy pulled from the translatable `notFound` UI
 * strings. Written at Astro's reserved `src/pages/404.astro` path so static
 * builds emit `dist/404.html` and the dev server serves it for unmatched routes.
 * Skipped by the generator when a user `pages/404.astro` already occupies the
 * `/404` route, so projects can fully override it.
 */
export const notFoundPageTemplate = (): string => `---
// Generated by Blume. Do not edit. Override by adding \`pages/404.astro\`.
import PageLayout from "blume/components/layout/PageLayout.astro";
import { withBase } from "blume/components/islands/base-path.ts";
import data from "blume:data";

export const prerender = true;

const nf = data.ui.notFound;

// The 404 page is an unlocalized route, so its chrome renders in the default
// locale's dictionary and direction (\`data.ui\` is the default locale's resolved
// dictionary), mirroring the catch-all's locale wiring.
const i18n = data.config.i18n;
const localeMeta = i18n
  ? i18n.locales.find((l) => l.code === i18n.defaultLocale)
  : null;
const dir = localeMeta?.dir ?? "ltr";
const htmlLang = i18n ? i18n.defaultLocale : "en";
---

<PageLayout
  site={{ title: data.config.title, description: data.config.description }}
  logo={data.config.logo}
  favicon={data.config.favicon}
  appleIcon={data.config.appleIcon}
  banner={data.config.banner}
  analytics={data.config.analytics}
  navigation={data.navigation}
  page={{ title: nf.title, route: "/404" }}
  themeMode={data.config.theme.mode}
  fontCssVars={data.fontCssVars}
  searchEnabled={data.config.search.enabled}
  locale={htmlLang}
  dir={dir}
  ui={data.ui}
  noindex={true}
>
  <div
    class="mx-auto flex min-h-[60vh] max-w-2xl flex-col items-center justify-center gap-4 px-6 py-24 text-center"
  >
    <p class="text-6xl font-bold text-muted-foreground">404</p>
    <h1 class="text-2xl font-semibold text-foreground">{nf.title}</h1>
    <p class="text-muted-foreground">{nf.description}</p>
    <a
      class="mt-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground"
      href={withBase("/")}>{nf.home}</a
    >
  </div>
</PageLayout>
`;

/** The literal Astro hydration directive for an island's client mode. */
const islandDirective = (spec: IslandSpec): string =>
  spec.client === "only"
    ? `client:only="${spec.framework}"`
    : `client:${spec.client}`;

/**
 * Frontmatter `Props` alias mirroring the wrapped component's own props, so
 * `{...Astro.props}` satisfies required props under `astro check` (the spread
 * of an untyped `Astro.props` contributes nothing to the JSX props type).
 * `infer P extends object` rather than `Record<string, unknown>` because
 * interfaces have no implicit index signature and would miss the narrower
 * constraint. Non-function component types (Vue/Svelte ambient modules) fall
 * back to an open record, keeping the untyped permissiveness they had.
 */
const wrapperPropsType = (name: string): string =>
  `type Props = typeof ${name} extends (
  props: infer P extends object,
  ...rest: never[]
) => unknown
  ? P
  : Record<string, unknown>;`;

/**
 * Generate `.blume/src/generated/islands/<Name>.astro` — a wrapper that renders
 * a convention island with its hydration directive applied. Astro client
 * directives must be written statically, so one wrapper is emitted per island;
 * props and the default slot (MDX children) forward through.
 */
export const islandWrapperTemplate = (spec: IslandSpec): string =>
  `---
// Generated by Blume. Do not edit.
import Island from ${JSON.stringify(spec.file)};
${wrapperPropsType("Island")}
---
<Island ${islandDirective(spec)} {...Astro.props}><slot /></Island>
`;

/**
 * Generate `.blume/src/generated/islands.ts` — the map of island names to their
 * wrappers, spread into the MDX component scope by the catch-all page. Always
 * written (an empty map when there are no islands) so the import resolves.
 */
export const islandMapTemplate = (specs: IslandSpec[]): string => {
  if (specs.length === 0) {
    return `// Generated by Blume. Do not edit.
export const islandComponents = {};
`;
  }
  const imports = specs
    .map(
      (spec, index) => `import I${index} from "./islands/${spec.name}.astro";`
    )
    .join("\n");
  const entries = specs
    .map((spec, index) => `  ${spec.name}: I${index},`)
    .join("\n");
  return `// Generated by Blume. Do not edit.
${imports}
export const islandComponents = {
${entries}
};
`;
};

/** The literal Astro hydration directive for an example's framework/client. */
const exampleDirective = (spec: ExampleSpec): string => {
  if (spec.framework === "astro" || !spec.client) {
    return "";
  }
  return spec.client === "only"
    ? `client:only="${spec.framework}" `
    : `client:${spec.client} `;
};

/** Filesystem-safe slug for an example's generated wrapper file. */
/**
 * A filesystem-safe, injective token for an example path. Distinct paths must
 * never share a wrapper file (`button.demo` vs `button-demo` used to collide),
 * so every non-alphanumeric character is hex-escaped rather than collapsed.
 */
export const exampleSlug = (path: string): string =>
  path.replaceAll(
    /[^a-zA-Z0-9]/gu,
    (char) => `_${(char.codePointAt(0) ?? 0).toString(16)}_`
  );

/**
 * Generate `.blume/src/generated/examples/<slug>.astro` — a wrapper that renders
 * one example live, with its hydration directive applied (none for `.astro`).
 * Mirrors {@link islandWrapperTemplate}; `<Component>` resolves these by path.
 */
export const exampleWrapperTemplate = (spec: ExampleSpec): string =>
  `---
// Generated by Blume. Do not edit.
import Example from ${JSON.stringify(spec.file)};
${wrapperPropsType("Example")}
---
<Example ${exampleDirective(spec)}{...Astro.props}><slot /></Example>
`;

/**
 * The route prefix `<Component />` preview frames are served under:
 * `{basePath}/blume-examples/<example path>`. `deployment.base` is layered on
 * top by Astro (components apply it with `withBase`).
 */
export const examplesRouteBase = (basePath: string): string =>
  `${basePath}/blume-examples`;

/**
 * Generate `.blume/src/generated/examples.ts` — a map of example path to its live
 * wrapper component plus raw source and language for the code tab, and the route
 * base preview iframes point at. Reached by the shipped `Component.astro` and the
 * generated preview page via the `blume:examples` alias. Always written (an
 * empty object when there are no examples) so the alias resolves.
 */
export const exampleMapTemplate = (
  specs: ExampleSpec[],
  basePath: string
): string => {
  const base = `export const examplesBase = ${JSON.stringify(
    examplesRouteBase(basePath)
  )};`;
  if (specs.length === 0) {
    return `// Generated by Blume. Do not edit.
${base}
export const examples = {};
`;
  }
  const imports = specs
    .map(
      (spec, index) =>
        `import E${index} from "./examples/${exampleSlug(spec.path)}.astro";`
    )
    .join("\n");
  const entries = specs
    .map(
      (spec, index) =>
        `  ${JSON.stringify(spec.path)}: { Component: E${index}, code: ${JSON.stringify(
          spec.source
        )}, lang: ${JSON.stringify(spec.lang)} },`
    )
    .join("\n");
  return `// Generated by Blume. Do not edit.
${imports}
${base}
export const examples = {
${entries}
};
`;
};

/**
 * Generate the `<Component />` preview page — one prerendered route per
 * example under `{basePath}/blume-examples/`, rendered as a bare document
 * (no layout) that an iframe in the docs page embeds. The iframe boundary is
 * what isolates examples from the docs CSS: the only stylesheet here is the
 * example entry (`blume:examples-theme` — Tailwind, the Blume tokens, and the
 * user's configured examples css), so users can preview components styled by
 * their own design system (e.g. shadcn) with no prose styles bleeding in.
 *
 * The inline script mirrors the docs theme before first paint — same-document
 * reads of the parent's `data-theme` (same origin) with a MutationObserver for
 * live toggles — and sets both `data-theme` and a `dark` class so either
 * dark-mode convention works in user CSS. When the page is opened directly
 * (no parent), it falls back to the stored preference, then the OS setting.
 *
 * A second script reports the example's rendered height to the parent
 * (`blume:example-height` via postMessage) so the docs page can size the
 * preview pane to the content instead of guessing from the source line count.
 * A ResizeObserver keeps the report live, so examples that grow or shrink
 * after load (chat threads, accordions) stay in sync.
 */
export const examplesPageTemplate = (): string =>
  `---
// Generated by Blume. Do not edit.
import { examples } from "blume:examples";
import "blume:examples-theme";

// Prerendered even in server output, like docs content.
export const prerender = true;

export const getStaticPaths = () =>
  Object.keys(examples).map((path) => ({ params: { path } }));

const { path } = Astro.params;
const entry = path ? examples[path] : undefined;
if (!entry) {
  return new Response(null, { status: 404 });
}
const Example = entry.Component;
---

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>{path}</title>
    <script is:inline>
      (() => {
        const root = document.documentElement;
        const apply = (theme) => {
          root.dataset.theme = theme;
          root.classList.toggle("dark", theme === "dark");
        };
        const stored = () =>
          localStorage.getItem("blume-theme") ??
          (matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light");
        try {
          const host = window.parent.document.documentElement;
          apply(host.dataset.theme ?? stored());
          new MutationObserver(() => {
            apply(host.dataset.theme ?? stored());
          }).observe(host, { attributeFilter: ["data-theme"] });
        } catch {
          apply(stored());
        }
      })();
    </script>
  </head>
  <!-- Flex + margin:auto centers the example and, unlike place-items, keeps
       the top edge reachable when the example outgrows the frame. -->
  <body style="display:flex;min-height:100svh;padding:1.5rem">
    <div data-blume-example style="margin:auto"><Example /></div>
    <script is:inline>
      (() => {
        // Report the example's rendered height so the embedding docs page can
        // size the preview pane to the content. The wrapper is observed rather
        // than the body: the body stretches to the frame's own height, so it
        // would only echo the pane back. Direct opens have no distinct parent
        // and skip out; the frame is same-origin with the docs page (see the
        // theme sync above), so the origin is pinned on both ends.
        if (window.parent === window) {
          return;
        }
        const wrapper = document.querySelector("[data-blume-example]");
        if (!wrapper) {
          return;
        }
        // The body's padding frames the example; fold it into the report so
        // the parent can apply the number as-is. Read from the live value —
        // the user's examples.css is injected after Blume's defaults precisely
        // so their tokens win, so a root font-size override must be honored
        // rather than assuming 1.5rem is 48px.
        const bodyStyle = getComputedStyle(document.body);
        const paddingPx =
          parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom);
        new ResizeObserver(() => {
          window.parent.postMessage(
            {
              height:
                Math.ceil(wrapper.getBoundingClientRect().height) + paddingPx,
              type: "blume:example-height",
            },
            window.location.origin
          );
        }).observe(wrapper);
      })();
    </script>
  </body>
</html>
`;

/** Generate `.blume/src/env.d.ts`. */
export const envTemplate =
  (): string => `/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

declare module "blume:ask" {
  const Ask: typeof import("blume/components/islands/AskAI.astro").default;
  export default Ask;
}

declare module "blume:data" {
  const data: import("blume").BlumeData;
  export default data;
}

declare module "blume:examples" {
  type Examples = typeof import("./generated/examples.ts").examples;
  export const examples: Record<string, Examples[keyof Examples]>;
  export const examplesBase: string;
}

declare module "blume:examples-theme";

declare module "blume:openapi" {
  const specs: import("blume/openapi/model.ts").OpenApiData;
  export default specs;
}

declare module "blume:search-client" {
  export const createSearch: () =>
    | import("blume/components/layout/search/types.ts").SearchFn
    | Promise<import("blume/components/layout/search/types.ts").SearchFn>;
}
`;

/** Generate `.blume/package.json`. */
export const runtimePackageTemplate = (dependencies: string[] = []): string =>
  `${JSON.stringify(
    {
      dependencies: Object.fromEntries(
        [...dependencies].toSorted().map((name) => [name, "*"])
      ),
      name: "blume-runtime",
      private: true,
      type: "module",
      version: "0.0.0",
    },
    null,
    2
  )}\n`;

/** Generate `.blume/tsconfig.json`. */
export const runtimeTsconfigTemplate = (): string =>
  `${JSON.stringify(
    {
      exclude: ["dist"],
      extends: "astro/tsconfigs/strict",
      include: [".astro/types.d.ts", "**/*"],
    },
    null,
    2
  )}\n`;

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { dirname, isAbsolute, join, relative } from "pathe";

import type { AskRetrievalOptions } from "../ai/ask-context.ts";
import { askBackendRuntimeDep } from "../ai/ask.ts";
import type { AskBackend } from "../ai/ask.ts";
import { buildHomeLinkHeader } from "../ai/link-headers.ts";
import { normalizeBasePath } from "../core/base-path.ts";
import { TOC_HIDDEN_KEY } from "../core/heading-markers.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import { BLUME_IGNORE_DIRS } from "../core/sources/watch.ts";
import { trimChar } from "../core/trim.ts";
import type { ProjectContext } from "../core/types.ts";
import { applyBaseToAstroRedirects } from "../deploy/redirects.ts";
import type { OgFont, OgFontFamilies } from "../og/card.ts";
import { hasScalarReferences } from "../openapi/references.ts";
import { searchProviderMeta } from "../search/providers.ts";
import { buildFontEntries, fontLocaleCodes } from "../theme/fonts.ts";
import type { ExampleSpec } from "./examples.ts";
import type { BlumePageRoute } from "./integration.ts";
import type { IslandSpec } from "./islands.ts";
import type { OgCustomRoute } from "./pages.ts";
import { RUNTIME_MODULE_FILES } from "./runtime-modules.ts";

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
    // SAFETY: parsed from the user's own package.json; only the presence of a
    // `workspaces` field is read, so this loose shape is all the cast claims.
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

type DeploymentAdapter = NonNullable<ResolvedConfig["deployment"]["adapter"]>;

const ADAPTER_IMPORTS = {
  cloudflare: "@astrojs/cloudflare",
  netlify: "@astrojs/netlify",
  node: "@astrojs/node",
  vercel: "@astrojs/vercel",
} satisfies Record<DeploymentAdapter, string>;

/** Adapter constructor arguments, for the adapters that need any. */
const ADAPTER_OPTIONS = new Map<DeploymentAdapter, string>([
  ["node", '{ mode: "standalone" }'],
]);

const WRANGLER_CONFIG_FILES = [
  "wrangler.jsonc",
  "wrangler.json",
  "wrangler.toml",
];

const resolveCloudflareAdapterArgs = (context: ProjectContext): string => {
  // Every Blume HTML route prerenders (the only server routes are API
  // endpoints), so images are optimized at build time with sharp. The
  // adapter's default (`cloudflare-binding`) would instead declare a runtime
  // `IMAGES` binding in the generated wrangler config that nothing uses.
  const args: string[] = [
    'prerenderEnvironment: "node"',
    'imageService: "compile"',
  ];
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
 * Without a configured driver, `@astrojs/cloudflare` force-enables KV-backed
 * sessions and declares a `SESSION` kv_namespaces entry in the generated
 * wrangler config — which `wrangler deploy` then requires a real KV namespace
 * for, even though Blume never reads `Astro.session`. An explicit in-memory
 * driver keeps the binding out. Swap for Astro's session opt-out once
 * withastro/astro#16871 ships in the supported range.
 */
const resolveSessionOption = (deployment: {
  adapter: string | null;
  output: string;
}): string =>
  deployment.output === "server" && deployment.adapter === "cloudflare"
    ? "\n  session: { driver: sessionDrivers.memory() },"
    : "";

/** The named imports the generated config pulls from `astro/config`. */
const astroConfigImportLine = (options: {
  hasFonts: boolean;
  hasSession: boolean;
}): string => {
  const names = ["defineConfig"];
  if (options.hasFonts) {
    names.push("fontProviders");
  }
  if (options.hasSession) {
    names.push("sessionDrivers");
  }
  return `import { ${names.join(", ")} } from "astro/config";`;
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
  // (the `renderer: "scalar"` opt-out on either block). Blume-rendered
  // references parse at generate time and need no runtime Scalar dependency.
  if (hasScalarReferences(config)) {
    deps.push("@scalar/astro");
  }
  // Only the configured search provider's SDK is declared, so a project pulls in
  // (and the user installs) exactly the backend it uses — nothing more.
  deps.push(...searchProviderMeta(config.search.provider).runtimeDeps);
  // Ask AI's provider SDK, when its backend needs one (gateway uses core `ai`).
  if (config.ai.ask?.enabled && !config.ai.ask.endpoint) {
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

interface IntegrationBridgeOptions {
  /** Config path relative to the generated Astro config. */
  configFile: string;
  /** SHA-256 used to invalidate Astro's generated config. */
  sourceHash?: string;
}

const renderIntegrationBridge = (
  bridge: IntegrationBridgeOptions | undefined
) => {
  if (!bridge) {
    return {
      configSourceMarker: "",
      userConfigImports: "",
      userConfigSetup: "",
      userIntegrationSpread: "",
    };
  }
  return {
    configSourceMarker: bridge.sourceHash
      ? `// Blume config source SHA-256: ${bridge.sourceHash}\n`
      : "",
    userConfigImports: `import { dirname, resolve } from "node:path";\nimport { fileURLToPath } from "node:url";\nimport { createModuleLoader } from "blume/core/load-module.ts";\n`,
    userConfigSetup: `const loadBlumeConfig = createModuleLoader();\nconst blumeConfig = await loadBlumeConfig(resolve(dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(
      bridge.configFile
    )}));\n\n`,
    userIntegrationSpread: ", ...(blumeConfig?.integrations ?? [])",
  };
};

/**
 * The generated config's `image` block. Remote images are only optimized when
 * their host is authorized; local (relative-path) images need no
 * configuration. Emitted only when set, so the generated config stays minimal.
 */
const renderImageOption = (config: ResolvedConfig): string =>
  config.image.domains.length > 0 || config.image.remotePatterns.length > 0
    ? `\n  image: ${JSON.stringify(config.image)},`
    : "";

/** What `resolveOptimizeDeps` feeds the generated `optimizeDeps` block. */
interface OptimizeDepsConfig {
  optimizeDepsEntries: string[];
  optimizeDepsInclude: string[];
}

/**
 * Startup-scan entry points and forced includes for the dev dep optimizer:
 * the Vite root is the generated runtime, so user pages, convention islands,
 * and alias-reachable components all live outside it and are otherwise only
 * crawled when first requested. The compiler runtime rides the include list
 * because it is Babel-injected and no source scan can see it. @vitejs/plugin-react
 * would add it itself, but only when the babel plugin is passed by its bare
 * name (`getReactCompilerPlugin` is an exact string match) — Blume passes an
 * absolute path (see `reactIntegration`), which that check never matches. See
 * the optimizeDeps comment in the generated config for the failure this prevents.
 */
const resolveOptimizeDeps = (options: {
  aliases: Record<string, string> | undefined;
  context: ProjectContext;
  needsReact: boolean;
  reactCompilerPath: string | null | undefined;
}): OptimizeDepsConfig => {
  const { context } = options;
  const optimizeDepsEntries = [
    ...(context.pagesRoot ? [`${context.pagesRoot}/**/*.astro`] : []),
    `${context.root}/islands/**/*.{jsx,svelte,tsx,vue}`,
    ...[...new Set(Object.values(options.aliases ?? {}))]
      .toSorted()
      .map((dir) => `${dir}/**/*.{astro,jsx,svelte,tsx,vue}`),
  ];
  const optimizeDepsInclude = [
    "blume > mermaid",
    "blume > epub-gen-memory/bundle",
    // Astro's own client-router/prefetch virtual modules are deliberately NOT
    // forced in here: they read Vite `define`-injected constants
    // (__PREFETCH_PREFETCH_ALL__ and friends) that a pre-bundled copy loses,
    // throwing ReferenceError on every page. Astro manages their optimization
    // itself, without a mid-session reload.
    ...(options.needsReact && options.reactCompilerPath
      ? ["react/compiler-runtime"]
      : []),
  ];
  return { optimizeDepsEntries, optimizeDepsInclude };
};

/**
 * How the generated config reaches the runtime data modules (`blume:data`,
 * the search index, …): served from memory by `runtimeModulesPlugin` in the
 * hidden runtime, or aliased to JSON files under `generatedModulesDir` for an
 * ejected project, which has no CLI to publish them (see `runtime-modules.ts`).
 */
interface RuntimeModuleWiring {
  /** `resolve.alias` entries (one per module), empty in the in-memory form. */
  aliasLines: string;
  /** Extra `blume/astro` imports the wiring needs. */
  imports: string[];
  /** Leading `vite.plugins` entry, empty in the file-alias form. */
  pluginEntry: string;
}

const renderRuntimeModuleWiring = (
  generatedModulesDir: string | undefined
): RuntimeModuleWiring => {
  if (generatedModulesDir === undefined) {
    return {
      aliasLines: "",
      imports: ["runtimeModulesPlugin"],
      pluginEntry: "runtimeModulesPlugin(), ",
    };
  }
  const aliasLines = [...RUNTIME_MODULE_FILES]
    .map(
      ([id, file]) =>
        `\n        ${JSON.stringify(id)}: ${JSON.stringify(`${generatedModulesDir}/${file}`)},`
    )
    .join("");
  return { aliasLines, imports: [], pluginEntry: "" };
};

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
  examplesPath: string;
  /** The example-preview Tailwind entry (`blume:examples-theme`). */
  examplesThemePath: string;
  themePath: string;
  searchClientPath: string;
  /**
   * Where the runtime data modules (`blume:data`, the search index, …) live as
   * JSON files, for a project with no CLI to publish them in memory (eject):
   * each id is aliased to its file under this directory. Absent, the modules
   * are served from memory by `runtimeModulesPlugin` — the hidden runtime.
   */
  generatedModulesDir?: string;
  /**
   * Absolute path to `babel-plugin-react-compiler` when the React Compiler is
   * enabled (resolved from Blume's package root by the caller); null/absent
   * disables the compiler and emits a bare `react()`.
   */
  reactCompilerPath?: string | null;
  /** Project tsconfig path aliases (`find` -> absolute dir), e.g. `@` -> src. */
  aliases?: Record<string, string>;
  /**
   * The docs collection's content root; bounds `<include>` resolution in the
   * processors and locates the include graph for dev-server invalidation.
   */
  contentRoot?: string;
  /** Bridge used to load configured integrations without serializing them. */
  integrationBridge?: IntegrationBridgeOptions;
}): string => {
  const { context, config, needsReact, pages, themePath } = options;
  const {
    askPath,
    contentRoutes,
    examplesPath,
    examplesThemePath,
    generatedModulesDir,
    needsSvelte,
    needsVue,
    searchClientPath,
  } = options;
  const {
    aliasLines: runtimeModuleAliasLines,
    imports: runtimeModuleImports,
    pluginEntry: runtimeModulesPluginEntry,
  } = renderRuntimeModuleWiring(generatedModulesDir);
  const { deployment } = config;
  const userAliasLines = renderUserAliases(options.aliases);
  const server = deployment.output === "server";

  // The project root plus the workspace root, so hoisted dependencies (e.g.
  // KaTeX fonts under a monorepo's root node_modules) stay servable in dev.
  const fsAllow = [...new Set([findWorkspaceRoot(context.root), context.root])];

  const { optimizeDepsEntries, optimizeDepsInclude } = resolveOptimizeDeps({
    aliases: options.aliases,
    context,
    needsReact,
    reactCompilerPath: options.reactCompilerPath,
  });

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
    return ADAPTER_OPTIONS.get(deployment.adapter) ?? "";
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

  const sessionOption = resolveSessionOption(deployment);

  const siteOption = deployment.site
    ? `\n  site: ${JSON.stringify(deployment.site)},`
    : "";
  const baseOption = deployment.base
    ? `\n  base: ${JSON.stringify(deployment.base)},`
    : "";
  const imageOption = renderImageOption(config);

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

  // Self-hosted fonts via Astro's Fonts API, derived from theme.fonts.
  // `fontProviders` is only imported when at least one font is configured.
  // Local variant sources are emitted as absolute paths (the Astro root is
  // `.blume/`, not the user's project, so root-relative paths would miss).
  // Subsets follow the configured locales (a Vietnamese site loads the
  // `vietnamese` faces) unless a family pins its own.
  const fontEntries = buildFontEntries(
    config.theme.fonts,
    fontLocaleCodes(config.i18n)
  );
  const fontsOption = fontEntries.length
    ? `\n  fonts: [${fontEntries
        .map((font) =>
          font.kind === "local"
            ? `{ provider: fontProviders.local(), name: ${JSON.stringify(
                font.name
              )}, cssVariable: ${JSON.stringify(
                font.cssVariable
              )}, fallbacks: ${JSON.stringify(
                font.fallbacks
              )}, options: { variants: ${JSON.stringify(
                font.variants.map((variant) => {
                  const face: Pick<typeof variant, "style" | "weight"> = {};
                  if (variant.weight !== undefined) {
                    face.weight = variant.weight;
                  }
                  if (variant.style !== undefined) {
                    face.style = variant.style;
                  }
                  return {
                    ...face,
                    src: [
                      isAbsolute(variant.src)
                        ? variant.src
                        : join(context.root, variant.src),
                    ],
                  };
                })
              )} } }`
            : `{ provider: fontProviders.${font.provider}(), name: ${JSON.stringify(
                font.name
              )}, cssVariable: ${JSON.stringify(
                font.cssVariable
              )}, weights: ${JSON.stringify(
                font.weights
              )}, subsets: ${JSON.stringify(
                font.subsets
              )}, fallbacks: ${JSON.stringify(font.fallbacks)} }`
        )
        .join(", ")}],`
    : "";
  const defineConfigImport = astroConfigImportLine({
    hasFonts: fontEntries.length > 0,
    hasSession: sessionOption.length > 0,
  });

  // Framework renderers are only wired in when an island (or Ask AI, for React)
  // needs them. The core theme is Astro-first and ships no client JS.
  const reactImport = needsReact ? `import react from "@astrojs/react";\n` : "";
  const vueImport = needsVue ? `import vue from "@astrojs/vue";\n` : "";
  const svelteImport = needsSvelte
    ? `import svelte from "@astrojs/svelte";\n`
    : "";
  const blumeImports = [
    "blumeIntegration",
    "includeHmrPlugin",
    "prerenderDepsPlugin",
    ...runtimeModuleImports,
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
      contentRoot: options.contentRoot,
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
  // up dev-server `Accept: text/markdown` negotiation over the content routes,
  // plus the homepage agent-discovery `Link` header.
  integrations.push(
    `blumeIntegration(${JSON.stringify({
      base: deployment.base,
      contentRoutes,
      homeLinkHeader: buildHomeLinkHeader(config, contentRoutes) ?? undefined,
      pages,
    })})`
  );

  const {
    configSourceMarker,
    userConfigImports,
    userConfigSetup,
    userIntegrationSpread,
  } = renderIntegrationBridge(options.integrationBridge);

  return `// Generated by Blume. Do not edit; this file is recreated on each run.
${configSourceMarker}${userConfigImports}${defineConfigImport}
import mdx from "@astrojs/mdx";
import tailwindcss from "@tailwindcss/vite";
import { blumeMarkdownProcessor, blumeMdxProcessor, blumeShikiTransformers, blumeTwoslashTransformer } from "blume/markdown";
${reactImport}${vueImport}${svelteImport}${blumeImport}${adapterImport}
${userConfigSetup}export default defineConfig({
  root: ${JSON.stringify(context.outDir)},
  srcDir: ${JSON.stringify(`${context.outDir}/src`)},
  outDir: ${JSON.stringify(astroOutDir(context))},
  publicDir: ${JSON.stringify(`${context.root}/public`)},
  output: ${JSON.stringify(deployment.output)},${adapterOption}${sessionOption}${siteOption}${baseOption}${imageOption}${redirectsOption}${i18nOption}${fontsOption}
  integrations: [${integrations.join(", ")}${userIntegrationSpread}],
  markdown: {
    processor: blumeMarkdownProcessor(${JSON.stringify({
      basePath: config.basePath,
      codeThemes: config.markdown.codeBlocks.theme,
      contentRoot: options.contentRoot,
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
  // The layouts render Astro's <ClientRouter />, and its in-place swaps read
  // from the prefetch cache — fetching every link on hover/viewport hides the
  // request latency behind the user's intent, so most navigations swap
  // instantly.
  prefetch: { prefetchAll: true },
  vite: {
    plugins: [${runtimeModulesPluginEntry}tailwindcss(), includeHmrPlugin(${JSON.stringify(
      `${context.outDir}/src/generated/includes.json`
    )}), prerenderDepsPlugin()],
    // Everything hydration can reach must be part of the dev dep optimizer's
    // FIRST run. The Vite root is the generated runtime, so user pages,
    // islands, and aliased components live outside it and are only crawled
    // when first requested — and \`react/compiler-runtime\` is Babel-injected,
    // so no source scan can ever see it. A dependency discovered after
    // hydration begins triggers a mid-session re-optimization whose new
    // generation imports React through new \`?v=\` URLs; the browser then
    // evaluates a second React copy and every island tears down with
    // "Invalid hook call" (#157). \`entries\` points the startup scanner at
    // the user's files (the scanner follows their imports, so their deps land
    // in the initial optimization); the compiler runtime rides the include
    // list because only the transform pipeline knows it exists.
    //
    // The mermaid/epub includes fix CJS interop instead: both lazy client-side
    // imports land on CJS/UMD files (mermaid statically imports dayjs as CJS,
    // epub-gen-memory's browser bundle is a browserified UMD) that break when
    // served as raw ESM — mermaid throws on load and the EPUB export throws
    // \`epub is not a function\`. They resolve through the \`blume\` package
    // (they aren't direct deps of the generated project), so the nested
    // \`blume > x\` form is required, and epub-gen-memory must name the
    // \`/bundle\` subpath that is actually imported: optimizing the package
    // root leaves that entry out. Production (Rollup) already handles the
    // interop, so all of this only affects dev.
    optimizeDeps: {
      entries: ${JSON.stringify(optimizeDepsEntries)},
      include: ${JSON.stringify(optimizeDepsInclude)},
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
        "blume:examples": ${JSON.stringify(examplesPath)},
        "blume:examples-theme": ${JSON.stringify(examplesThemePath)},
        "blume:search-client": ${JSON.stringify(searchClientPath)},
        "blume:theme": ${JSON.stringify(themePath)},${runtimeModuleAliasLines}${userAliasLines}
      },
    },
    server: {
      fs: {
        allow: ${JSON.stringify(fsAllow)},
      },
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
 * Drives the collection's negative glob in `contentConfigTemplate`, which both
 * keeps runtime-dir files out of the collection and (Astro's watcher honors
 * negated patterns) keeps the content watcher off Astro's own `.astro` writes.
 */
const runtimeDirWithin = (base: string, outDir: string): string | null => {
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

  // With no filesystem source, no route renders through `docs`, so glob
  // nothing: an all-staged project roots the collection at the project dir,
  // and a patterned glob would scan (and watch) the whole project for nothing.
  // The collection is still declared below so `getCollection("docs")` /
  // `getEntry` resolve (to empty).
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
import { withIncludeRefresh } from "blume/astro";

// withIncludeRefresh keeps <include>-bearing pages fresh: plain .md entries
// are rendered at sync time and digest-cached on the page file alone, so a
// partial edit (or a warm-cache rebuild after one) would serve stale HTML.
const docs = defineCollection({
  loader: withIncludeRefresh(glob({
    pattern: ${JSON.stringify(docsPattern)},
    base: ${JSON.stringify(astroGlobBase(collectionBase))},
    generateId: ({ entry }) => entry,
  }), ${JSON.stringify(`${context.outDir}/src/generated/includes.json`)}),
});
${stagedBlock}
export const collections = { docs${options.staged ? ", staged" : ""} };
`;
};

/** Generate `.blume/src/pages/[...slug].astro`, the docs catch-all route. */
/** The plain prompt used when there is no grounding context to inject. */
const ASK_FALLBACK_PROMPT =
  "You are a helpful documentation assistant. Answer using the project's documentation.";

/** The `ai.ask` values the generated endpoint has to carry with it. */
export interface AskEndpointOptions {
  /** `ai.ask.instructions` — extra system-prompt text. */
  instructions?: string;
  /** `ai.ask.retrieval` — how much documentation each question carries. */
  retrieval?: AskRetrievalOptions;
}

/**
 * Generate the Ask AI server endpoint (`.blume/src/pages/api/ask.ts`).
 *
 * `options.instructions` (the `ai.ask.instructions` config) is appended to the
 * built-in prompt on every path: the grounded prompt via `createAskContext`,
 * and the plain fallback here. `options.retrieval` (the `ai.ask.retrieval`
 * config) is forwarded to `createAskContext` on the grounded path, where it
 * sizes retrieval. Both travel in one options object so a new call site can't
 * silently drop one of them.
 */
export const askEndpointTemplate = (
  backend: AskBackend,
  grounded: boolean,
  options?: AskEndpointOptions
): string => {
  const instructions = options?.instructions;
  const fallbackPrompt = instructions
    ? `${ASK_FALLBACK_PROMPT}\n\n${instructions}`
    : ASK_FALLBACK_PROMPT;
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
      'import askData from "blume:ask-data";'
    );
    const groundFields: string[] = [];
    if (instructions) {
      groundFields.push(`instructions: ${JSON.stringify(instructions)}`);
    }
    if (options?.retrieval) {
      groundFields.push(`retrieval: ${JSON.stringify(options.retrieval)}`);
    }
    const groundOptions =
      groundFields.length > 0 ? `, { ${groundFields.join(", ")} }` : "";
    setup += `\nconst ground = createAskContext(askData${groundOptions});\n`;
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
    ? `    const instructions =
      (await ground(messages, body.page)) ??
      ${JSON.stringify(fallbackPrompt)};
    const result = streamText({
      model: ${modelExpr},
      instructions,
      messages,
${onError}
    });`
    : `    const result = streamText({
      model: ${modelExpr},
      instructions:
        ${JSON.stringify(fallbackPrompt)},
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

<AskAI
  endpoint={data.config.ask?.endpoint ?? undefined}
  strings={strings ?? data.ui.ask}
  suggestions={data.config.ask?.suggestions ?? []}
/>
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
import documents from "blume:search-index";

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

/**
 * A client that loads a static `blume-search.json` index (Orama, FlexSearch).
 * `locale` (Orama only) is the site's `i18n.defaultLocale`, which selects a
 * word-segmenting tokenizer for every non-Latin script.
 */
const staticSearchClient = (module: string, locale?: string): string =>
  `${SEARCH_CLIENT_HEADER}${searchClientImport(module)}${SEARCH_BASE_IMPORT}
const indexUrl = joinBase(import.meta.env.BASE_URL, "blume-search.json");

export const createSearch = () => create({ indexUrl${
    locale ? `, locale: ${JSON.stringify(locale)}` : ""
  } });
`;

/**
 * Public credential fields baked into a hosted provider's generated client
 * (Algolia/Orama Cloud/Typesense config values from `search.*`, all plain
 * strings or numbers; `JSON.stringify` drops the absent ones).
 */
type HostedSearchCredentials = Record<string, string | number | undefined>;

/** A client that passes public credentials straight to the provider SDK. */
const hostedSearchClient = (
  module: string,
  options: HostedSearchCredentials
): string =>
  `${SEARCH_CLIENT_HEADER}${searchClientImport(module)}
export const createSearch = () => create(${JSON.stringify(options)});
`;

/** Build the per-provider config object the hosted client is created with. */
const hostedSearchOptions = (
  search: ResolvedConfig["search"]
): { module: string; options: HostedSearchCredentials } | null => {
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
    // Only Orama derives a tokenizer from the locale; FlexSearch has no
    // equivalent hook, so its client keeps the bare index URL.
    const locale =
      search.provider === "orama" ? config.i18n?.defaultLocale : undefined;
    return staticSearchClient(search.provider, locale);
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
import raw from "blume:raw-markdown";

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
  const body = entry ? ${
    kind === "md" ? '(entry.md ?? entry.mdx ?? "")' : '(entry.mdx ?? "")'
  } : "";
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      // ~4 characters per token; keep in sync with markdownTokenCount.
      "x-markdown-tokens": String(Math.ceil(body.length / 4)),
    },
  });
}
`;

/**
 * Generate the `/blume-assets/[...asset]` endpoint. It serves two families of
 * files that exist on disk but outside the public dir:
 *   - `content/<project-relative path>` — colocated content images
 *     (`![alt](./diagram.png)`), served as originals for the agent-facing
 *     Markdown endpoints (the HTML render uses the `astro:assets`-optimized
 *     copies instead). The mapping comes from `generated/content-assets.json`.
 *   - `<source>/<hash>.<ext>` — remote-source images the scan pipeline
 *     materializes under `.blume/public/blume-assets` (see
 *     `core/sources/assets.ts`). That directory is NOT Astro's `publicDir`
 *     (which points at the user project's `public/`), so without this endpoint
 *     those references 404.
 * Prerendered: every asset becomes a static file in the build output; the dev
 * server renders on demand, so new images appear without a restart.
 */
export const contentAssetsEndpointTemplate = (
  stagedAssetsDir: string
): string =>
  `// Generated by Blume. Do not edit.
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { APIRoute } from "astro";
import assets from "blume:content-assets";

export const prerender = true;

const files = assets as Record<string, string>;
const STAGED_DIR = ${JSON.stringify(stagedAssetsDir)};

const TYPES: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

const contentType = (path: string): string =>
  TYPES[path.slice(path.lastIndexOf(".")).toLowerCase()] ??
  "application/octet-stream";

const stagedParams = async (): Promise<string[]> => {
  if (!existsSync(STAGED_DIR)) {
    return [];
  }
  const entries = await readdir(STAGED_DIR, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(STAGED_DIR, join(entry.parentPath, entry.name)).replaceAll(
        "\\\\",
        "/"
      )
    );
};

export async function getStaticPaths() {
  const params = [
    ...Object.keys(files).map((key) => "content/" + key),
    ...(await stagedParams()),
  ];
  return params.map((asset) => ({ params: { asset } }));
}

const resolveAsset = (asset: string): string | null => {
  if (asset.startsWith("content/")) {
    return files[asset.slice("content/".length)] ?? null;
  }
  const abs = resolve(STAGED_DIR, asset);
  // Traversal guard: the dev server renders on demand, so the param is
  // attacker-controlled there — never step outside the staged directory.
  // path.relative rather than a string-prefix test: STAGED_DIR is baked in
  // with forward slashes while resolve() answers in the platform's
  // separators, so on Windows the prefix test 404'd every legitimate staged
  // asset — and a bare prefix also admits a sibling directory that merely
  // shares the name.
  const rel = relative(STAGED_DIR, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return null;
  }
  return existsSync(abs) ? abs : null;
};

export const GET: APIRoute = async ({ params }) => {
  const path = resolveAsset(String(params.asset ?? ""));
  if (!path) {
    return new Response(null, { status: 404 });
  }
  const body = await readFile(path);
  return new Response(new Uint8Array(body), {
    headers: { "Content-Type": contentType(path) },
  });
};
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
export const mcpEndpointTemplate = (): string =>
  `// Generated by Blume. Do not edit.
import type { APIRoute } from "astro";
import { createMcpFetchHandler } from "blume/ai/mcp/server.ts";
import data from "blume:mcp-data";

export const prerender = false;

const handler = createMcpFetchHandler(data);

export const ALL: APIRoute = ({ request }) => handler(request);
`;

/**
 * Generate the playground's CORS proxy endpoint
 * (`.blume/src/blume-openapi/api-proxy.ts`), behind
 * `openapi.playground.proxy: true`. A thin server-rendered wrapper around the
 * shipped `createPlaygroundProxyHandler`; injected at `/_api-proxy` rather
 * than written under `pages/` because Astro treats `_`-prefixed page files as
 * private.
 *
 * `origins` — the origins of the servers the documented specs declare — is
 * baked in as the handler's allowlist. It cannot come from the request or from
 * client-side data: that is the whole trust boundary keeping the endpoint from
 * being an open proxy onto the deployment's own network.
 */
export const playgroundProxyTemplate = (origins: string[]): string =>
  `// Generated by Blume. Do not edit.
import type { APIRoute } from "astro";
import { createPlaygroundProxyHandler } from "blume/openapi/proxy.ts";

export const prerender = false;

const handler = createPlaygroundProxyHandler(${JSON.stringify(origins)});

export const ALL: APIRoute = ({ request }) => handler(request);
`;

/** Generate a prerendered endpoint that serves a fixed JSON payload. */
export const staticJsonEndpointTemplate = <Payload extends object>(
  payload: Payload
): string =>
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
import feeds from "blume:rss";

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

/** Generate the OG image endpoint (`.blume/src/pages/og/[...slug].png.ts`). */
export const ogEndpointTemplate = (
  customRoutes: OgCustomRoute[] = [],
  og: {
    families?: OgFontFamilies;
    fonts?: OgFont[];
    /**
     * Whether a page's own description may replace the site-wide subtitle.
     * `false` when `seo.og.description` is `false`, which hides the subtitle
     * on every card, page text included. Defaults to `true`.
     */
    pageDescriptions?: boolean;
  } = {},
  includeChangelog = false
): string =>
  `// Generated by Blume. Do not edit.
import { renderOgImage } from "blume/og";
import type { OgFont, OgFontFamilies } from "blume/og";
import data from "blume:data";

export const prerender = true;

// Custom (non-content) pages opted into a generated card, baked in at build.
// The annotation keeps the empty-array case from being an implicit any[]
// (ts(7034)) under a strict tsconfig.
const customRoutes: { slug: string; title: string }[] = ${JSON.stringify(customRoutes)};

// Card fonts, resolved at generation time (explicit seo.og.fonts, or derived
// from theme.fonts). Local entries carry absolute build-machine paths, which
// is why they are baked into this build-only endpoint instead of the runtime
// data that pages serialize into HTML.
const fonts: OgFont[] = ${JSON.stringify(og.fonts ?? [])};
const families: OgFontFamilies | undefined = ${
    og.families ? JSON.stringify(og.families) : "undefined"
  };

// A page's own description (its \`seo.description\`, else \`description\`) is
// the card subtitle, so the image says what the page's og:description says.
// Pages without one fall back to the site-wide subtitle at render time.
// \`seo.og.description: false\` hides the subtitle on every card, page text
// included, which is what switches this off.
const pageDescriptions = ${og.pageDescriptions !== false};

interface CardProps {
  title: string;
  description: string | null;
}

export function getStaticPaths() {
  const seen = new Set<string>();
  const paths: { params: { slug: string }; props: CardProps }[] = [];
  const add = (slug: string, title: string, description: string | null) => {
    if (seen.has(slug)) {
      return;
    }
    seen.add(slug);
    paths.push({
      params: { slug },
      props: { title, description: pageDescriptions ? description : null },
    });
  };
  // A custom page wins over a content route sharing its path, so add it first.
  // Its description is unknown at generate time, so it takes the site subtitle.
  for (const route of customRoutes) {
    add(route.slug, route.title, null);
  }
  for (const route of data.routes) {
    add(
      route.path === "/" ? "index" : route.path.slice(1),
      route.title,
      route.description
    );
  }${
    includeChangelog
      ? `
  // The generated changelog index is not a content route, so it needs its own
  // card. Added last: a custom page or content route owning /changelog wins.
  add(
    "changelog",
    data.ui.changelog?.title ?? "Changelog",
    data.ui.changelog?.description ?? null
  );`
      : ""
  }
  return paths;
}

// Footer branding shared by every card. The slug comes from the configured
// repo rather than the URL, so an Enterprise host reads the same as github.com;
// the site text (host plus deployment base) is resolved at generate time.
const repoSlug = data.config.github
  ? \`\${data.config.github.owner}/\${data.config.github.repo}\`
  : undefined;

export async function GET({ props }: { props: CardProps }) {
  const png = await renderOgImage({
    accent: data.config.og.palette?.accent ?? data.config.theme.accent.light,
    brand: data.config.title,
    description: props.description ?? data.config.og.description,
    families,
    fonts,
    logo: data.config.og.logo,
    palette: data.config.og.palette,
    repo: repoSlug,
    site: data.config.og.site,
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
 * live inside our shell.
 */
export const scalarReferenceTemplate = <Configuration extends object>(options: {
  /** Scalar options forwarded verbatim (spec/theme config plus the author's `scalar` escape hatch). */
  configuration: Configuration;
  noindex?: boolean;
  route: string;
  title: string;
}): string =>
  `---
// Generated by Blume. Do not edit.
import { ScalarComponent } from "@scalar/astro";
import ReferenceLayout from "blume/components/layout/ReferenceLayout.astro";
import data from "blume:data";

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
  noindex={${options.noindex === true}}
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
      version: route.version,
      versionAlternates: route.versionAlternates,
    },
  }));
}

const { entryId, collection, route, title, indexable, editUrl, lastModified, locale, alternates, fallback, version, versionAlternates } = Astro.props;
const entry = await getEntry(collection as CollectionKey, entryId);
if (!entry) {
  return new Response(null, { status: 404 });
}
const { Content, headings: allHeadings, remarkPluginFrontmatter } = await render(entry);
// \`[!toc]\`-marked headings render on the page but stay out of the table of
// contents; the heading plugin reports their slugs through the render's
// frontmatter (see markdown/heading-anchors.ts). Only the plugin's array
// counts: \`frontmatter.extend\` can declare the same key, and on a page with
// no headings that user-supplied value would pass straight through.
const tocHiddenRaw = remarkPluginFrontmatter?.${TOC_HIDDEN_KEY};
const tocHidden = new Set(Array.isArray(tocHiddenRaw) ? tocHiddenRaw : []);
const headings =
  tocHidden.size > 0
    ? allHeadings.filter((heading) => !tocHidden.has(heading.slug))
    : allHeadings;
const frontmatter = entry.data ?? {};

const seo = frontmatter.seo ?? {};
const base = data.config.site ? data.config.site.replace(/\\/$/, "") : null;

// Percent-encode the route-derived path (the sitemap convention): a Unicode
// slug (\`/api/größe\`) is not legal in a raw URI, and crawlers compare
// canonical against the sitemap's encoded <loc> byte-for-byte.
const ogPath = data.config.og.enabled
  ? encodeURI(\`/og/\${route === "/" ? "index" : route.slice(1)}.png\`)
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

// Version resolution. An archived page renders its snapshot's navigation tree,
// points its canonical at the latest equivalent (unless configured otherwise),
// and shows the old-version notice.
const versionsConfig = data.config.versions;
const archived = versionsConfig && version
  ? (versionsConfig.archived.find((v) => v.id === version) ?? null)
  : null;
const latestVersionAlt = (versionAlternates ?? []).find((alt) => alt.version === "");

const navigation = version
  ? (data.navigationByVersion[version]?.[i18n ? locale : ""] ?? data.navigation)
  : i18n
    ? (data.navigationByLocale[locale] ?? data.navigation)
    : data.navigation;
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
// The root route keeps its trailing slash (\`https://site/\`) so canonical and
// hreflang URLs byte-match the sitemap's <loc> for the home page.
const absolute = (path: string) => base + withBase(path);

// An archived page defaults its canonical to the same page in the latest docs
// when that page still exists — search engines treat the live page as
// authoritative without deindexing version-only content. A page's own
// \`seo.canonical\` always wins, and \`canonical: "self"\` keeps the default.
const canonical =
  seo.canonical ??
  (archived && archived.canonical === "latest" && latestVersionAlt && base
    ? absolute(latestVersionAlt.path)
    : base
      ? \`\${base}\${basedRoute === "/" ? "/" : encodeURI(basedRoute)}\`
      : null);
const effectiveNoindex = Boolean(seo.noindex) || (archived?.noindex ?? false);

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

// Version switcher + old-version notice. The switcher auto-populates from the
// versions config as a \`kind: "version"\` selector; a user-declared version
// selector in \`navigation.selectors\` suppresses it (theirs renders instead).
// Fallback version roots compose like real routes — \`{basePath}/{locale?}/{id}\`
// (manifest \`versionAlternates\` paths arrive with the base already applied).
const versionRootFor = (id: string) => {
  const logical = id ? \`/\${id}\` : "/";
  const localized = i18n ? localizeRoute(logical, locale) : logical;
  const mount = data.config.basePath;
  if (!mount) {
    return localized;
  }
  return localized === "/" ? mount : \`\${mount}\${localized}\`;
};
const samePageSwitch = versionsConfig
  ? versionsConfig.switcher.redirect === "same-page"
  : true;
const userHasVersionSelector = navigation.selectors.some(
  (selector) => selector.kind === "version"
);
const versionSelector =
  versionsConfig && !userHasVersionSelector
    ? {
        items: [
          {
            id: "",
            label: versionsConfig.current.label,
            tag: versionsConfig.current.badge,
          },
          ...versionsConfig.archived.map((v) => ({
            id: v.id,
            label: v.label ?? v.id,
            tag: undefined,
          })),
        ].map((entry) => {
          const alt = (versionAlternates ?? []).find(
            (a) => a.version === entry.id
          );
          return {
            label: entry.label,
            path: samePageSwitch && alt ? alt.path : versionRootFor(entry.id),
            ...(entry.tag ? { tag: entry.tag } : {}),
          };
        }),
        kind: "version" as const,
        label: ui.versions.switcher,
      }
    : null;

const versionNotice =
  archived && archived.banner !== false
    ? {
        latestHref: latestVersionAlt
          ? latestVersionAlt.path
          : versionRootFor(""),
        latestLabel: ui.versions.latest,
        message:
          typeof archived.banner === "string"
            ? archived.banner
            : ui.versions.notice.replace(
                "{version}",
                archived.label ?? archived.id
              ),
      }
    : null;

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
  versionSelector={versionSelector}
  versionNotice={versionNotice}
  searchVersion={versionsConfig ? version : null}
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
  openInChat={data.config.openInChat}
  feeds={data.feeds}
  discovery={data.config.discovery}
  siteUrl={data.config.site}
  pageType={frontmatter.type}
  published={frontmatter.date ?? frontmatter.changelog?.date ?? null}
  lastModified={lastModified}
  noindex={effectiveNoindex}
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

// The generated OG card for this route (the /og endpoint emits it alongside
// the content-route cards), absolutized like the catch-all's so crawlers get
// a full URL when the site is known.
const ogPath = data.config.og.enabled ? withBase("/og/changelog.png") : null;
const ogImage = ogPath && base ? base + ogPath : ogPath;

// The page chrome (h1, title, description) comes from the same translatable
// \`changelog\` group as the reveal button; optional chaining tolerates a
// not-yet-regenerated data snapshot from before these keys existed.
const changelogTitle = data.ui.changelog?.title ?? "Changelog";
const changelogDescription =
  data.ui.changelog?.description ??
  "Product updates, new features, and fixes from every release.";
// The layout suffixes "- {site title}" itself, so the page title is just the
// changelog's own name — prefixing the site title too would double it
// ("Acme Changelog - Acme").
const pageTitle = changelogTitle;

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
  ogImage={ogImage}
  ogGenerated={Boolean(ogImage)}
  x={data.config.x}
  canonical={canonical}
  exportPdf={${options.exportPdf}}
  exportEpub={${options.exportEpub}}
  openInChat={data.config.openInChat}
  feeds={data.feeds}
  discovery={data.config.discovery}
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
import Icon from "blume/components/Icon.astro";
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

// Recovery links, so a reader — or an agent that followed a stale URL — can
// get back on track without guessing: every top-level section, then the
// machine-readable indexes the build emits (the sitemap only exists with a
// \`deployment.site\`; llms.txt only when \`ai.llmsTxt\` is on). Tabs link to
// their resolved target when the section has no index page of its own.
const suggestions = [
  ...data.navigation.tabs.map((tab) => ({
    href: withBase(tab.href ?? tab.path),
    label: tab.label,
  })),
  ...(data.config.discovery.sitemap
    ? [{ href: withBase("/sitemap.xml"), label: nf.sitemap }]
    : []),
  ...(data.config.discovery.llmsTxt
    ? [{ href: withBase("/llms.txt"), label: nf.llms }]
    : []),
];
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
    class="mx-auto grid w-full max-w-5xl gap-12 px-6 py-20 sm:py-28 md:grid-cols-[3fr_2fr] md:gap-16 lg:gap-24 lg:py-36"
  >
    <div class="flex flex-col items-start">
      <p
        class="font-mono text-xs font-medium tracking-widest text-muted-foreground"
      >
        404
      </p>
      <h1
        class="mt-4 text-balance text-4xl font-semibold tracking-tight text-foreground sm:text-5xl"
      >
        {nf.title}
      </h1>
      <p class="mt-4 max-w-md text-pretty text-lg text-muted-foreground">
        {nf.description}
      </p>
      <a
        class="mt-8 inline-flex items-center gap-1.5 rounded-full bg-accent py-2 pe-4 ps-3.5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
        href={withBase("/")}
      >
        <Icon class="rtl:-scale-x-100" name="arrow-left" size={14} />
        {nf.home}
      </a>
    </div>
    {
      suggestions.length > 0 && (
        <nav aria-label={nf.suggestions} class="md:border-s md:border-border md:ps-12 lg:ps-16">
          <h2 class="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {nf.suggestions}
          </h2>
          <ul class="mt-4 divide-y divide-border border-y border-border">
            {suggestions.map((link) => (
              <li>
                <a
                  class="group flex items-center justify-between gap-4 py-3 text-sm font-medium text-foreground transition-colors hover:text-accent"
                  href={link.href}
                >
                  <span>{link.label}</span>
                  <Icon
                    class="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5"
                    name="arrow-right"
                    size={14}
                  />
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )
    }
  </div>
</PageLayout>
`;

/**
 * Generate `.blume/src/pages/404.md.ts`: the Markdown twin of the default 404
 * page, prerendered to `dist/404.md`. An agent that asked for a missing page
 * with `Accept: text/markdown` — or fetched a `.md` URL no page backs — gets
 * this body with the 404 status instead of the HTML shell; Vercel server
 * builds wire that into the routing config (`deploy/vercel-negotiation.ts`).
 * Same recovery links as the HTML page, absolute when the site URL is known:
 * the body is read out of context, so a relative link would leave the reader
 * guessing the host. Written alongside `404.astro` and skipped under the same
 * rule, so a project that owns `/404` owns both variants.
 */
export const notFoundMarkdownTemplate =
  (): string => `// Generated by Blume. Do not edit. Override by adding \`pages/404.astro\`.
import { withBase } from "blume/components/islands/base-path.ts";
import { absoluteUrl } from "blume/core/site-url.ts";
import data from "blume:data";

export const prerender = true;

const nf = data.ui.notFound;

// Absolute for internal routes when the site is known; an external tab href
// passes through untouched.
const href = (path: string): string => {
  const based = withBase(path);
  return data.config.site && based.startsWith("/") && !based.startsWith("//")
    ? absoluteUrl(data.config.site, based)
    : based;
};

// The recovery set of 404.astro: home, every top-level section (a tab links to
// its resolved target), then the machine-readable indexes that exist.
const links = [
  { href: href("/"), label: nf.home },
  ...data.navigation.tabs.map((tab) => ({
    href: href(tab.href ?? tab.path),
    label: tab.label,
  })),
  ...(data.config.discovery.sitemap
    ? [{ href: href("/sitemap.xml"), label: nf.sitemap }]
    : []),
  ...(data.config.discovery.llmsTxt
    ? [{ href: href("/llms.txt"), label: nf.llms }]
    : []),
];

const body = [
  "# " + nf.title,
  "",
  nf.description,
  "",
  "## " + nf.suggestions,
  "",
  ...links.map((link) => "- [" + link.label + "](" + link.href + ")"),
  "",
].join("\\n");

export function GET() {
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      // ~4 characters per token; keep in sync with markdownTokenCount.
      "x-markdown-tokens": String(Math.ceil(body.length / 4)),
    },
  });
}
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

declare module "blume:ask-data" {
  const askData: import("blume/ai/ask-context.ts").AskData;
  export default askData;
}

declare module "blume:content-assets" {
  const assets: Record<string, string>;
  export default assets;
}

declare module "blume:mcp-data" {
  const data: import("blume/ai/mcp/data.ts").McpData;
  export default data;
}

declare module "blume:raw-markdown" {
  const raw: Record<string, import("blume/ai/markdown.ts").RawMarkdownEntry>;
  export default raw;
}

declare module "blume:rss" {
  const feeds: Record<string, string>;
  export default feeds;
}

declare module "blume:search-index" {
  const documents: import("blume/search/documents.ts").SearchDocument[];
  export default documents;
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

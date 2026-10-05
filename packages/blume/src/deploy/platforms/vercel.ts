import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { dirname, join } from "pathe";

import { crossOriginDiscoveryPaths } from "../../ai/ai-catalog.ts";
import {
  API_CATALOG_PATH,
  API_CATALOG_TYPE,
  hasApiCatalog,
} from "../../ai/api-catalog.ts";
import { buildHomeLinkHeader } from "../../ai/link-headers.ts";
import {
  agentMarkdown,
  buildRawMarkdown,
  markdownRoutePaths,
  markdownTokenCount,
} from "../../ai/markdown.ts";
import {
  SIGNATURES_DIRECTORY_PATH,
  SIGNATURES_DIRECTORY_TYPE,
} from "../../ai/web-bot-auth.ts";
import { mountBasePath, normalizeBasePath } from "../../core/base-path.ts";
import type { BlumeProject } from "../../core/project-graph.ts";
import { isPatternPath, regexRedirect } from "../../core/redirect-patterns.ts";
import type { ResolvedConfig } from "../../core/schema.ts";
import type { ProjectContext } from "../../core/types.ts";
import { VERCEL_ADAPTER_PACKAGE } from "../adapters/vercel.ts";
import {
  addDevDependencyCommand,
  auditVercelFunctions,
  blumeDependencyNames,
  functionBundleVerdict,
} from "../function-bundle.ts";
import {
  buildVercelConfig,
  platformRedirects,
  vercelPatternRoutes,
} from "../redirects.ts";
import {
  injectNegotiationRoutes,
  injectRedirectRoutes,
  rebaseAdapterRoutes,
} from "../vercel-negotiation.ts";
import type { VercelRoute } from "../vercel-negotiation.ts";
import { adapterRoot, toSiteUrl } from "./paths.ts";
import type { BuildLog, DeployPlatform, RedirectFile } from "./types.ts";

/** `vercel.json` with a `redirects` array, for a static deploy of `dist/`. */
export const VERCEL_JSON_FILE: RedirectFile = {
  build: buildVercelConfig,
  name: "vercel.json",
};

/**
 * The Build Output tree. The adapter is shown the project root (see
 * `hiddenRuntime.showProjectRoot`), so for a real build this is
 * `<project>/.vercel/output`; an isolated build keeps it under the relocated
 * runtime.
 */
const buildOutputDir = (context: ProjectContext): string =>
  join(adapterRoot(context), ".vercel", "output");

/** The static files a server build serves, under the base's directory. */
const staticDir = (context: ProjectContext, base: string): string =>
  join(buildOutputDir(context), "static", base);

/** The project's normalized `deployment.base`, `""` for none. */
const deploymentBase = (project: BlumeProject): string =>
  normalizeBasePath(project.config.deployment.options.base);

/**
 * Refuse to ship a function bundle that would crash at runtime: a bare import
 * the adapter's dependency trace silently dropped (see
 * `deploy/function-bundle.ts`). A missing package that is one of Blume's own
 * dependencies is fatal — the generated runtime imports it, so every request
 * would die; a project's own external import is reported as a warning and
 * left to the author. Resolves to whether the bundle may ship.
 */
export const checkVercelFunctionBundles = async (
  outputDir: string,
  root: string,
  log: BuildLog
): Promise<boolean> => {
  const audits = await auditVercelFunctions(outputDir);
  const own = blumeDependencyNames();
  // The remedy names the project's own package manager (`pnpm add -D`, …).
  const addDevCommand = await addDevDependencyCommand(root);
  let fatal = false;
  for (const audit of audits) {
    const verdict = functionBundleVerdict(audit, root, own, addDevCommand);
    if (verdict.fatal) {
      fatal = true;
      log.error(verdict.message);
    } else {
      log.warn(verdict.message);
    }
  }
  return !fatal;
};

/**
 * Splice `Accept: text/markdown` negotiation routes into the adapter's Build
 * Output config, so a content-page request that prefers Markdown gets the
 * page's prerendered `.md` mirror (content pages are prerendered even in
 * server output, so Astro middleware never sees them — the routing layer is
 * the only request-time hook). The adapter writes the config straight to the
 * root it was shown.
 */
export const emitVercelNegotiation = async (
  project: BlumeProject,
  log: BuildLog
): Promise<void> => {
  const { config, context } = project;
  const configPath = join(buildOutputDir(context), "config.json");
  if (!existsSync(configPath)) {
    return;
  }
  const base = deploymentBase(project);
  const routePaths = markdownRoutePaths(project);
  // Keyed by the file's path in `static/`, under the base's directory.
  const overrides: Record<string, string> = {};
  if (hasApiCatalog(config)) {
    overrides[mountBasePath(base, API_CATALOG_PATH).slice(1)] =
      API_CATALOG_TYPE;
  }
  if (config.agents.webBotAuth.keys.length > 0) {
    overrides[mountBasePath(base, SIGNATURES_DIRECTORY_PATH).slice(1)] =
      SIGNATURES_DIRECTORY_TYPE;
  }
  // The homepage rewrite serves `/index.md` from the static layer, so its
  // `x-markdown-tokens` estimate has to ride the routing config; the runtime
  // endpoint stamps it on dev/server-rendered responses itself.
  const rawMarkdown = await buildRawMarkdown(project);
  const home = rawMarkdown["/"];
  // The Markdown and JSON 404 routes point at the prerendered twins; only
  // wire each when the build actually emitted it (a project that owns `/404`
  // gets none).
  const builtDir = staticDir(context, base);
  const injected = injectNegotiationRoutes(
    await readFile(configPath, "utf-8"),
    routePaths,
    buildHomeLinkHeader(config, routePaths),
    overrides,
    home ? markdownTokenCount(agentMarkdown(home)) : undefined,
    {
      json: existsSync(join(builtDir, "404.json")),
      markdown: existsSync(join(builtDir, "404.md")),
    },
    crossOriginDiscoveryPaths(config),
    // Downloaded content assets are prerendered static files; only a build
    // that has them needs the SVG sandbox route.
    existsSync(join(builtDir, "blume-assets")),
    base
  );
  if (injected === null) {
    log.warn(
      "Could not wire Accept: text/markdown negotiation into .vercel/output/config.json — raw Markdown stays available at the .md URLs."
    );
    return;
  }
  await writeFile(configPath, injected, "utf-8");
  log.success(
    "Wired Accept: text/markdown negotiation into the Vercel routing config"
  );
};

/**
 * Route the pattern redirects (`/beta/:slug*`) in the adapter's Build Output
 * config: Astro's `redirects` carry only the exact ones, since it can't
 * prerender a pattern's pages, so the adapter never sees these.
 */
export const emitVercelPatternRedirects = async (
  project: BlumeProject,
  log: BuildLog
): Promise<void> => {
  const routes = vercelPatternRoutes(platformRedirects(project));
  const configPath = join(buildOutputDir(project.context), "config.json");
  if (routes.length === 0 || !existsSync(configPath)) {
    return;
  }
  const injected = injectRedirectRoutes(
    await readFile(configPath, "utf-8"),
    routes
  );
  if (injected === null) {
    log.warn(
      "Could not route the pattern redirects in .vercel/output/config.json, so paths they cover answer 404."
    );
    return;
  }
  await writeFile(configPath, injected, "utf-8");
};

type Redirect = ResolvedConfig["redirects"][number];

/**
 * The exact redirects as Build Output routes, matched the way the pattern ones
 * are (see `regexRedirect`): the served path, a trailing slash optional.
 */
const exactRedirectRoutes = (redirects: Redirect[]): VercelRoute[] =>
  redirects
    .filter((redirect) => !isPatternPath(redirect.from))
    .map(({ from, status, to }) => ({
      headers: { Location: encodeURI(to) },
      src: regexRedirect({ parts: [{ kind: "text", text: from }], status, to })
        .source,
      status,
    }));

/**
 * Move a server build's static files under `deployment.base`.
 * `@astrojs/vercel` copies them to the root of the Build Output tree's
 * `static/`, while the pages request `<base>/_astro/…` and link to
 * `<base>/…`, so nothing the site asks for would be found. Moved to
 * `static/<base>/`, they're served at the base, as the routes that
 * {@link rebaseVercelRoutes} moves there expect.
 */
export const moveStaticUnderBase = async (
  context: ProjectContext,
  base: string
): Promise<void> => {
  const root = staticDir(context, "");
  if (!base || !existsSync(root)) {
    return;
  }
  // Through a sibling, since the target lies inside the directory it moves.
  const staging = join(buildOutputDir(context), "static-unbased");
  await rename(root, staging);
  const target = staticDir(context, base);
  await mkdir(dirname(target), { recursive: true });
  await rename(staging, target);
};

/**
 * Move the adapter's routing config under `deployment.base` to match the
 * static files (see `rebaseAdapterRoutes`), its exact redirects rebuilt from
 * the configured ones. Resolves to false when the config can't be read: the
 * adapter's routes would then miss every path under the base.
 */
export const rebaseVercelRoutes = async (
  project: BlumeProject,
  log: BuildLog
): Promise<boolean> => {
  const base = deploymentBase(project);
  const configPath = join(buildOutputDir(project.context), "config.json");
  if (!base || !existsSync(configPath)) {
    return true;
  }
  const rebased = rebaseAdapterRoutes(
    await readFile(configPath, "utf-8"),
    base,
    exactRedirectRoutes(platformRedirects(project))
  );
  if (rebased === null) {
    log.error(
      `Could not move the routes in .vercel/output/config.json under the deployment base "${base}", so the site would not be served there.`
    );
    return false;
  }
  await writeFile(configPath, rebased, "utf-8");
  return true;
};

/**
 * Vercel. A server build's Build Output tree lands at `.vercel/output` — at
 * the project root, because the adapter is handed that root up front: its
 * `@vercel/nft` dependency trace is rooted there too, and tracing from the
 * hidden runtime silently drops the function's chunks and `node_modules`.
 * Static assets are served from the tree's `static/` half, so the deploy
 * artifacts are written there; headers (the discovery files', the sandbox on
 * downloaded SVGs) arrive through the routing config rather than a
 * `_headers` file, which Vercel never reads. The adapter ignores
 * `deployment.base`, so under one the build moves the static files and the
 * routes beneath it.
 */
export const vercelPlatform: DeployPlatform = {
  astro: {
    config: () => ({}),
    configOptions: [],
    options: () => ({}),
    package: VERCEL_ADAPTER_PACKAGE,
  },
  env: {
    detect: (env) => Boolean(env.VERCEL),
    // The stable production domain wins over the per-deployment preview URL
    // so the inferred origin (sitemap, OG, RSS) stays put across deploys;
    // the chain falls through per resolved value, so an empty
    // VERCEL_PROJECT_PRODUCTION_URL doesn't dead-end it.
    site: (env) =>
      toSiteUrl(env.VERCEL_PROJECT_PRODUCTION_URL) ?? toSiteUrl(env.VERCEL_URL),
  },
  finalizeBuild: async ({ isolated, log, project }) => {
    const { context } = project;
    const ok = await checkVercelFunctionBundles(
      buildOutputDir(context),
      context.root,
      log
    );
    if (!ok) {
      return false;
    }
    // A verify build moves its static files too, where the budget gate reads
    // them (`serverStaticDir`).
    await moveStaticUnderBase(context, deploymentBase(project));
    // An isolated verify only proves the bundle would ship; the routing
    // config is a deploy artifact and stays untouched.
    if (isolated) {
      return true;
    }
    if (!(await rebaseVercelRoutes(project, log))) {
      return false;
    }
    await emitVercelNegotiation(project, log);
    await emitVercelPatternRedirects(project, log);
    return true;
  },
  hiddenRuntime: {
    ignoreDir: ".vercel/",
    showProjectRoot: true,
    surfacePath: null,
  },
  kind: "vercel",
  negotiatesMarkdown: true,
  // @astrojs/vercel declares no preview entrypoint.
  previewDeploy: "vercel deploy",
  readsHeaderFiles: { server: false, static: false },
  redirectFiles: [VERCEL_JSON_FILE],
  serverClientUnderBase: false,
  serverOutputDir: buildOutputDir,
  serverStaticDir: staticDir,
};

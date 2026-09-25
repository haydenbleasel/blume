import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import { join } from "pathe";

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
import type { BlumeProject } from "../../core/project-graph.ts";
import type { ProjectContext } from "../../core/types.ts";
import { VERCEL_ADAPTER_PACKAGE } from "../adapters/vercel.ts";
import {
  addDevDependencyCommand,
  auditVercelFunctions,
  blumeDependencyNames,
  functionBundleVerdict,
} from "../function-bundle.ts";
import { buildVercelConfig } from "../redirects.ts";
import { injectNegotiationRoutes } from "../vercel-negotiation.ts";
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
  const outputDir = buildOutputDir(context);
  const configPath = join(outputDir, "config.json");
  if (!existsSync(configPath)) {
    return;
  }
  const routePaths = markdownRoutePaths(project);
  const overrides: Record<string, string> = {};
  if (hasApiCatalog(config)) {
    overrides[API_CATALOG_PATH.slice(1)] = API_CATALOG_TYPE;
  }
  if (config.agents.webBotAuth.keys.length > 0) {
    overrides[SIGNATURES_DIRECTORY_PATH.slice(1)] = SIGNATURES_DIRECTORY_TYPE;
  }
  // The homepage rewrite serves `/index.md` from the static layer, so its
  // `x-markdown-tokens` estimate has to ride the routing config; the runtime
  // endpoint stamps it on dev/server-rendered responses itself.
  const rawMarkdown = await buildRawMarkdown(project);
  const home = rawMarkdown["/"];
  // The Markdown and JSON 404 routes point at the prerendered twins; only
  // wire each when the build actually emitted it (a project that owns `/404`
  // gets none).
  const staticDir = join(outputDir, "static");
  const injected = injectNegotiationRoutes(
    await readFile(configPath, "utf-8"),
    routePaths,
    buildHomeLinkHeader(config, routePaths),
    overrides,
    home ? markdownTokenCount(agentMarkdown(home)) : undefined,
    {
      json: existsSync(join(staticDir, "404.json")),
      markdown: existsSync(join(staticDir, "404.md")),
    },
    crossOriginDiscoveryPaths(config),
    // Downloaded content assets are prerendered static files; only a build
    // that has them needs the SVG sandbox route.
    existsSync(join(staticDir, "blume-assets"))
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
 * Vercel. A server build's Build Output tree lands at `.vercel/output` — at
 * the project root, because the adapter is handed that root up front: its
 * `@vercel/nft` dependency trace is rooted there too, and tracing from the
 * hidden runtime silently drops the function's chunks and `node_modules`.
 * Static assets are served from the tree's `static/` half, so the deploy
 * artifacts are written there; headers (the discovery files', the sandbox on
 * downloaded SVGs) arrive through the routing config rather than a
 * `_headers` file, which Vercel never reads.
 */
export const vercelPlatform: DeployPlatform = {
  astro: {
    config: {},
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
    // An isolated verify only proves the bundle would ship; the routing
    // config is a deploy artifact and stays untouched.
    if (!isolated) {
      await emitVercelNegotiation(project, log);
    }
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
  serverStaticDir: (context) => join(buildOutputDir(context), "static"),
};

import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";

import { build } from "astro";
import { defineCommand } from "citty";
import { join } from "pathe";

import { crossOriginDiscoveryPaths } from "../../ai/ai-catalog.ts";
import {
  API_CATALOG_PATH,
  API_CATALOG_TYPE,
  hasApiCatalog,
} from "../../ai/api-catalog.ts";
import { pageJsonPath } from "../../ai/api/paths.ts";
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
import { publishBuildProject } from "../../astro/integration.ts";
import { ensureGitignore } from "../../core/gitignore.ts";
import type { BlumeProject } from "../../core/project-graph.ts";
import type { ResolvedConfig } from "../../core/schema.ts";
import { serverFeatures } from "../../core/server-features.ts";
import type { ProjectContext } from "../../core/types.ts";
import {
  ADAPTER_IGNORE_DIRS,
  deployStaticDir,
  servesClientSubdir,
  surfaceAdapterOutput,
} from "../../deploy/adapter-output.ts";
import {
  injectWorkerNegotiation,
  NEGOTIATION_WORKER_FILE,
} from "../../deploy/cloudflare-negotiation.ts";
import {
  auditVercelFunctions,
  blumeDependencyNames,
  functionBundleVerdict,
} from "../../deploy/function-bundle.ts";
import { platformRedirects } from "../../deploy/redirects.ts";
import { injectNegotiationRoutes } from "../../deploy/vercel-negotiation.ts";
import { cardCacheTally, ogCacheDir, pruneCardCache } from "../../og/cache.ts";
import { commandMeta } from "../command-meta.ts";
import { refuseIfDevRunning } from "../dev-lock.ts";
import { logger } from "../log.ts";
import { prepareProject } from "../prepare.ts";

const ADAPTERS = ["vercel", "node", "netlify", "cloudflare"] as const;

const isAdapter = (value: string): value is (typeof ADAPTERS)[number] =>
  ADAPTERS.some((adapter) => adapter === value);

const BUDGET_JS = "budget-js";
const BUDGET_CSS = "budget-css";

interface BudgetArgs {
  "budget-css"?: string;
  "budget-js"?: string;
}

/**
 * Reject a non-numeric performance budget. `Number("250kb")` is `NaN` and
 * `total > NaN` is always false, so a typo'd flag would silently pass the gate;
 * fail up front instead.
 */
const validateBudgetFlags = (args: BudgetArgs): void => {
  for (const flag of [BUDGET_JS, BUDGET_CSS] as const) {
    const value = args[flag];
    const parsed = Number(value);
    // Equivalent to `!(parsed > 0)` but without the inverted check: this must
    // also reject `NaN` (a typo'd flag like "250kb"), which `parsed <= 0` alone
    // would let through since `NaN <= 0` is false.
    if (value !== undefined && (Number.isNaN(parsed) || parsed <= 0)) {
      logger.error(
        `Invalid --${flag} "${value}" (expected a positive number of kB).`
      );
      process.exit(1);
    }
  }
};

/**
 * Splice `Accept: text/markdown` negotiation routes into the Vercel adapter's
 * Build Output config, so a content-page request that prefers Markdown gets the
 * page's prerendered `.md` mirror (content pages are prerendered even in server
 * output, so Astro middleware never sees them — the routing layer is the only
 * request-time hook). Vercel server builds only; the adapter writes the config
 * straight to the project root (see `withAdapterRoot`).
 */
const emitVercelNegotiation = async (
  project: BlumeProject,
  routePaths: string[],
  root: string
): Promise<void> => {
  const { config } = project;
  const configPath = join(root, ".vercel", "output", "config.json");
  if (!existsSync(configPath)) {
    return;
  }
  const overrides: Record<string, string> = {};
  if (hasApiCatalog(config)) {
    overrides[API_CATALOG_PATH.slice(1)] = API_CATALOG_TYPE;
  }
  if (config.ai.webBotAuth.keys.length > 0) {
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
  const staticDir = join(root, ".vercel", "output", "static");
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
    crossOriginDiscoveryPaths(config)
  );
  if (injected === null) {
    logger.warn(
      "Could not wire Accept: text/markdown negotiation into .vercel/output/config.json — raw Markdown stays available at the .md URLs."
    );
    return;
  }
  await writeFile(configPath, injected, "utf-8");
  logger.success(
    "Wired Accept: text/markdown negotiation into the Vercel routing config"
  );
};

/**
 * Refuse to ship a Vercel function bundle that would crash at runtime: a bare
 * import the adapter's dependency trace silently dropped (see
 * `deploy/function-bundle.ts`). A missing package that is one of Blume's own
 * dependencies is fatal — the generated runtime imports it, so every request
 * would die; a project's own external import is reported as a warning and left
 * to the author.
 */
const checkVercelFunctionBundles = async (
  outputDir: string,
  root: string
): Promise<void> => {
  const audits = await auditVercelFunctions(outputDir);
  if (audits.length === 0) {
    return;
  }
  const own = blumeDependencyNames();
  let fatal = false;
  for (const audit of audits) {
    const verdict = functionBundleVerdict(audit, root, own);
    if (verdict.fatal) {
      fatal = true;
      logger.error(verdict.message);
    } else {
      logger.warn(verdict.message);
    }
  }
  if (fatal) {
    process.exit(1);
  }
};

const warnCloudflareNegotiationSkipped = (): void =>
  logger.warn(
    "Could not wire Accept: text/markdown negotiation into dist/server/wrangler.json — raw Markdown stays available at the .md URLs."
  );

/**
 * Wire `Accept: text/markdown` negotiation into a Cloudflare server build. The
 * ASSETS binding serves the prerendered content pages before the Worker runs —
 * and even a request that reaches the Worker is answered by the adapter's
 * handler from that binding, ahead of the only place middleware runs — so the
 * negotiation lives in a generated wrapper Worker, routed to by
 * `assets.run_worker_first` (see `deploy/cloudflare-negotiation.ts`). Both
 * pieces are spliced into the adapter's emitted `dist/server` bundle.
 */
const emitCloudflareNegotiation = async (
  project: BlumeProject,
  routePaths: string[]
): Promise<void> => {
  const { config, context } = project;
  const serverDir = join(
    context.distDir ?? join(context.root, "dist"),
    "server"
  );
  const wranglerPath = join(serverDir, "wrangler.json");
  if (!existsSync(wranglerPath)) {
    warnCloudflareNegotiationSkipped();
    return;
  }
  // The homepage mirror is served from the static layer, so its
  // `x-markdown-tokens` estimate rides the wrapper Worker, mirroring the
  // Vercel routing config.
  const rawMarkdown = await buildRawMarkdown(project);
  const home = rawMarkdown["/"];
  const injected = injectWorkerNegotiation(
    await readFile(wranglerPath, "utf-8"),
    {
      base: config.deployment.base,
      // The manifest routes guard the wrapper's redirect table; `routePaths`
      // also carries the synthesized homepage mirror, which must not block a
      // configured root redirect.
      contentRoutePaths: project.manifest.routes.map((route) => route.path),
      homeLinkHeader: buildHomeLinkHeader(config, routePaths),
      homeTokens: home ? markdownTokenCount(agentMarkdown(home)) : undefined,
      // Exactly the per-page JSON documents the API emits (see `pageParams`):
      // the non-hidden routes with agent Markdown, when the API is on.
      pageJsonPaths: config.ai.api
        ? project.manifest.routes
            .filter(
              (route) => !route.hidden && rawMarkdown[route.path] !== undefined
            )
            .map((route) => pageJsonPath(route.path))
        : [],
      // The wrapper Worker matches full served URLs, so the redirects are
      // based the same way the platform files are — it answers any the
      // worker-first rules claim, where `_redirects` is never consulted and
      // Astro would default their status.
      redirects: platformRedirects(config),
      routePaths,
    }
  );
  if (injected === null) {
    warnCloudflareNegotiationSkipped();
    return;
  }
  await writeFile(
    join(serverDir, NEGOTIATION_WORKER_FILE),
    injected.worker,
    "utf-8"
  );
  await writeFile(wranglerPath, injected.wrangler, "utf-8");
  logger.success(
    "Wired Accept: text/markdown negotiation into the Cloudflare Worker"
  );
};

/**
 * Report how many OG cards the build read back from the on-disk cache against
 * how many it rendered (the endpoint tallies both), so a warm rebuild shows
 * where the time went. With `prune`, also drop the cached cards this build
 * never asked for — renamed pages, edited descriptions, cards from an earlier
 * Blume version — so a persisted cache holds exactly the current site's cards.
 */
const reportCardCache = async (
  project: BlumeProject,
  prune: boolean
): Promise<void> => {
  const cards = cardCacheTally();
  if (!cards) {
    return;
  }
  logger.info(
    `OG cards: ${cards.hits} reused from the cache, ${cards.misses} rendered`
  );
  if (prune) {
    await pruneCardCache(ogCacheDir(project.context));
  }
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const digits = bytes < 1024 * 100 ? 1 : 0;
  return `${(bytes / 1024).toFixed(digits)} kB`;
};

/** Sizes of `dist/_astro/*.<ext>`, largest first (empty when none exist). */
const astroAssets = async (
  distDir: string,
  ext: string
): Promise<{ name: string; size: number }[]> => {
  const astroDir = join(distDir, "_astro");
  if (!existsSync(astroDir)) {
    return [];
  }
  const entries = await readdir(astroDir);
  const files = entries.filter((name) => name.endsWith(`.${ext}`));
  const sized = await Promise.all(
    files.map(async (name) => {
      const info = await stat(join(astroDir, name));
      return { name, size: info.size };
    })
  );
  return sized.toSorted((a, b) => b.size - a.size);
};

const totalSize = (assets: { size: number }[]): number =>
  assets.reduce((sum, asset) => sum + asset.size, 0);

/**
 * Print the client JavaScript Astro shipped, largest first, plus the total. A
 * dependency-free bundle report — the interactive weight of a docs site is its
 * `_astro/*.js`, so this surfaces regressions without a visualizer.
 */
const reportBundleSizes = async (distDir: string): Promise<void> => {
  const sized = await astroAssets(distDir, "js");
  if (sized.length === 0) {
    logger.info("No client JavaScript emitted — the site ships zero JS.");
    return;
  }
  const rows = sized
    .slice(0, 15)
    .map((file) => `  ${formatBytes(file.size).padStart(8)}  ${file.name}`);
  logger.box(
    [
      `Client JavaScript — ${sized.length} file(s), ${formatBytes(totalSize(sized))} total`,
      "",
      ...rows,
      sized.length > 15 ? `  … and ${sized.length - 15} more` : null,
    ]
      .filter((line) => line !== null)
      .join("\n")
  );
};

/**
 * Enforce a performance budget on the built client assets: fail the build when
 * total `_astro/*.js` (or `*.css`) exceeds the given kB cap. Budgets that would
 * otherwise be "documented, not measured" become a real CI gate. Returns whether
 * every budget passed.
 */
const enforceBudget = async (
  distDir: string,
  args: BudgetArgs
): Promise<"fail" | "pass" | "skip"> => {
  const checks: { ext: string; limitKb: number; name: string }[] = [
    ...(args[BUDGET_JS]
      ? [{ ext: "js", limitKb: Number(args[BUDGET_JS]), name: "JavaScript" }]
      : []),
    ...(args[BUDGET_CSS]
      ? [{ ext: "css", limitKb: Number(args[BUDGET_CSS]), name: "CSS" }]
      : []),
  ];
  if (checks.length === 0) {
    return "skip";
  }
  let passed = true;
  for (const check of checks) {
    // oxlint-disable-next-line no-await-in-loop -- a couple of sequential reads
    const total = totalSize(await astroAssets(distDir, check.ext));
    const limit = check.limitKb * 1024;
    if (total > limit) {
      passed = false;
      logger.error(
        `${check.name} budget exceeded: ${formatBytes(total)} > ${check.limitKb} kB`
      );
    } else {
      logger.success(
        `${check.name} budget: ${formatBytes(total)} / ${check.limitKb} kB`
      );
    }
  }
  return passed ? "pass" : "fail";
};

/**
 * Run the optional bundle report (`--analyze`) and performance-budget gate
 * against the directory whose `_astro/` client assets the deploy serves.
 * Shared by real and isolated builds — an isolated CI run passing
 * `--budget-js` must still fail on an exceeded budget rather than silently
 * skipping the check. Exits non-zero when a budget is exceeded.
 */
export const runClientAssetChecks = async (
  staticDir: string,
  args: { analyze?: boolean } & BudgetArgs
): Promise<void> => {
  if (args.analyze) {
    await reportBundleSizes(staticDir);
  }
  if ((await enforceBudget(staticDir, args)) === "fail") {
    process.exit(1);
  }
};

/**
 * Root of an isolated build's output. The runtime-local `dist/`, except for a
 * Vercel server build, whose deploy bundle lands at `<runtime>/.vercel/output`
 * and is never surfaced to the project root.
 */
export const isolatedOutputDir = (
  config: ResolvedConfig,
  context: ProjectContext
): string => {
  const { adapter, output } = config.deployment;
  if (output === "server" && adapter === "vercel") {
    return join(context.outDir, ".vercel", "output");
  }
  return context.distDir ?? join(context.outDir, "dist");
};

/**
 * Directory holding an isolated build's client `_astro/` assets. Mirrors
 * `deployStaticDir`, except that an isolated build never surfaces the adapter
 * bundle to the project root — a Vercel server build's static output stays at
 * `<runtime>/.vercel/output/static`, where `deployStaticDir` would instead
 * point at the project-root copy (a previous real build's assets, or nothing).
 * Node and Cloudflare server builds serve one level down, at `client/` — see
 * {@link servesClientSubdir}.
 */
export const isolatedStaticDir = (
  config: ResolvedConfig,
  context: ProjectContext
): string => {
  const { adapter, output } = config.deployment;
  const outputDir = isolatedOutputDir(config, context);
  if (output === "server" && adapter === "vercel") {
    return join(outputDir, "static");
  }
  if (servesClientSubdir(config.deployment)) {
    return join(outputDir, "client");
  }
  return outputDir;
};

/**
 * Print the build summary box and run the optional bundle report / budget
 * gate against the served static dir. The deploy artifacts themselves
 * (search index, llms.txt, sitemap, robots, redirect and header files, …)
 * were written by the integration's `astro:build:done` hook during
 * `build()` — see `deploy/artifacts.ts`. Exits non-zero if a budget is
 * exceeded.
 */
const reportBuild = async (
  project: BlumeProject,
  distDir: string,
  args: { analyze?: boolean } & BudgetArgs
): Promise<void> => {
  const { config } = project;
  const features = serverFeatures(config);
  // The sitemap needs both the flag and a `site` (absolute URLs) — only the
  // latter deserves the remediation hint.
  const sitemapNote = config.seo.sitemap
    ? "no (set deployment.site)"
    : "no (seo.sitemap is false)";
  logger.box(
    [
      `Output     ${config.deployment.output}`,
      `Adapter    ${config.deployment.adapter ?? "none"}`,
      `Site       ${config.deployment.site ?? "not set"}`,
      `Search     ${config.search.provider.kind}`,
      `Redirects  ${config.redirects.length}`,
      `Sitemap    ${config.deployment.site && config.seo.sitemap ? "yes" : sitemapNote}`,
      `Robots     ${config.seo.robots ? "yes" : "no"}`,
      `Agent JSON ${config.seo.agentReadability ? "yes" : "no"}`,
      `LLM files  ${config.ai.llmsTxt.enabled ? "yes" : "no"}`,
      `Server features  ${features.length > 0 ? features.join(", ") : "none"}`,
    ].join("\n")
  );

  await runClientAssetChecks(distDir, args);

  // Only reachable with --no-strict (strict aborts earlier): repeat the missing
  // count next to the success banner so it can't scroll away unseen.
  if (project.droppedPages > 0) {
    logger.warn(
      `${project.droppedPages} page(s) failed frontmatter validation and are missing from this build.`
    );
  }
  logger.success(`Built to ${distDir}`);
};

export const buildCommand = defineCommand({
  args: {
    adapter: {
      description: "Server adapter: vercel | node | netlify | cloudflare.",
      type: "string",
    },
    analyze: {
      description: "Report client JavaScript bundle sizes after the build.",
      type: "boolean",
    },
    base: {
      description: "Base path the site is served under (e.g. /docs).",
      type: "string",
    },
    [BUDGET_CSS]: {
      description: "Fail if total client CSS exceeds this many kB.",
      type: "string",
    },
    [BUDGET_JS]: {
      description: "Fail if total client JavaScript exceeds this many kB.",
      type: "string",
    },
    isolated: {
      description:
        "Build into an isolated .blume-verify runtime (and its own dist) so a running dev server and the real dist/ are untouched. For verifying changes while `blume dev` runs.",
      type: "boolean",
    },
    output: {
      description: "Output mode: static | server.",
      type: "string",
    },
    preview: {
      description: "Include drafts and unpublished CMS content.",
      type: "boolean",
    },
    strict: {
      default: true,
      description:
        "Fail on error diagnostics (default; pass --no-strict to build anyway, dropping pages that fail validation).",
      type: "boolean",
    },
  },
  meta: commandMeta.build,
  async run({ args }) {
    const root = process.cwd();

    // `--isolated` (or BLUME_RUNTIME_DIR) relocates the whole runtime to a
    // sibling dir so this build never touches a live dev server's `.blume/` or
    // the user's real `dist/`. A non-default runtime dir has no dev lock, so the
    // refusal below lets it proceed; a plain build still refuses.
    const runtimeDir = args.isolated
      ? ".blume-verify"
      : process.env.BLUME_RUNTIME_DIR;
    refuseIfDevRunning(root, "building", { isolatedHint: true, runtimeDir });
    if (args.isolated) {
      await ensureGitignore(root, [".blume-verify/"]);
    }

    if (args.output && args.output !== "static" && args.output !== "server") {
      logger.error(`Invalid --output "${args.output}" (use static | server).`);
      process.exit(1);
    }
    if (args.adapter && !isAdapter(args.adapter)) {
      logger.error(
        `Invalid --adapter "${args.adapter}" (use ${ADAPTERS.join(" | ")}).`
      );
      process.exit(1);
    }
    validateBudgetFlags(args);

    const project = await prepareProject({
      mode: "build",
      overrides: {
        // SAFETY: an invalid --adapter exited above; a set flag is an ADAPTERS
        // member.
        adapter: args.adapter as (typeof ADAPTERS)[number] | undefined,
        base: args.base,
        // SAFETY: an invalid --output exited above; a set flag is static or
        // server.
        output: args.output as "server" | "static" | undefined,
      },
      preview: args.preview,
      root,
      runtimeDir,
      strict: args.strict,
    });

    logger.start(
      `Building ${project.graph.pages.length} page(s) (${project.config.deployment.output} output)`
    );

    // Hand the scanned project to the integration: its `astro:build:done`
    // hook writes the deploy artifacts (search index, llms.txt, sitemap, …)
    // into Astro's client output during the build. An isolated build is a
    // throwaway verify that only needs to confirm the site compiles and
    // renders, so it publishes nothing — no network post-steps (a hosted
    // search sync would push), no deploy artifacts.
    if (!runtimeDir) {
      publishBuildProject(project);
    }

    await build({
      logLevel: "info",
      root: project.context.outDir,
    });

    // A real build also prunes the cache; an isolated verify must not evict
    // cards a live dev server is still serving.
    await reportCardCache(project, !runtimeDir);

    // The bundle report and budget gate still run for an isolated build —
    // `blume build --isolated --budget-js 100` exiting 0 without measuring
    // anything would be a silent false pass in CI.
    if (runtimeDir) {
      if (
        project.config.deployment.output === "server" &&
        project.config.deployment.adapter === "vercel"
      ) {
        await checkVercelFunctionBundles(
          isolatedOutputDir(project.config, project.context),
          root
        );
      }
      await runClientAssetChecks(
        isolatedStaticDir(project.config, project.context),
        args
      );
      logger.success(
        `Isolated build OK — output at ${isolatedOutputDir(project.config, project.context)} (not published).`
      );
      return;
    }

    // A server adapter's deploy bundle is a build artifact — keep it out of
    // version control (Vercel's own CLI ignores `.vercel/` for the same reason).
    // Ignoring it is independent of whether the bundle had to be moved below:
    // Vercel writes straight to the project root, Netlify does not.
    const { adapter } = project.config.deployment;
    const ignoreDir = adapter ? ADAPTER_IGNORE_DIRS[adapter] : undefined;
    if (project.config.deployment.output === "server" && ignoreDir) {
      await ensureGitignore(root, [ignoreDir]);
    }

    // Netlify writes its deploy bundle relative to the Astro root — which Blume
    // points at the hidden `.blume` runtime — so the bundle lands where the
    // deploy platform never looks. Surface it up to the project root before
    // publishing artifacts into the served static dir.
    const surfaced = await surfaceAdapterOutput(
      project.config,
      project.context
    );
    if (surfaced.moved) {
      logger.success(`Surfaced ${adapter} output to ${surfaced.to}`);
    }

    if (project.config.deployment.output === "server" && adapter === "vercel") {
      await checkVercelFunctionBundles(join(root, ".vercel", "output"), root);
      await emitVercelNegotiation(project, markdownRoutePaths(project), root);
    }

    if (
      project.config.deployment.output === "server" &&
      adapter === "cloudflare"
    ) {
      await emitCloudflareNegotiation(project, markdownRoutePaths(project));
    }

    await reportBuild(
      project,
      deployStaticDir(project.config, project.context),
      args
    );
  },
});

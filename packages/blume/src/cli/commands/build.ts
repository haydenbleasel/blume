import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";

import { build } from "astro";
import { defineCommand } from "citty";
import { join } from "pathe";

import { publishBuildProject } from "../../astro/integration.ts";
import { ensureGitignore } from "../../core/gitignore.ts";
import type { BlumeProject } from "../../core/project-graph.ts";
import { serverFeatures } from "../../core/server-features.ts";
import {
  deployOutputDir,
  deployStaticDir,
  surfaceAdapterOutput,
} from "../../deploy/adapter-output.ts";
import { deployPlatform } from "../../deploy/platforms/index.ts";
import { cardCacheTally, ogCacheDir, pruneCardCache } from "../../og/cache.ts";
import { commandMeta } from "../command-meta.ts";
import { refuseIfDevRunning } from "../dev-lock.ts";
import { logger } from "../log.ts";
import { prepareProject } from "../prepare.ts";

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
      `Output     ${config.deployment.options.output}`,
      `Adapter    ${config.deployment.kind}`,
      `Site       ${config.deployment.options.site ?? "not set"}`,
      `Search     ${config.search.provider.kind}`,
      `Redirects  ${config.redirects.length}`,
      `Sitemap    ${config.deployment.options.site && config.seo.sitemap ? "yes" : sitemapNote}`,
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
    analyze: {
      description: "Report client JavaScript bundle sizes after the build.",
      type: "boolean",
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

    validateBudgetFlags(args);

    const project = await prepareProject({
      mode: "build",
      preview: args.preview,
      root,
      runtimeDir,
      strict: args.strict,
    });

    logger.start(
      `Building ${project.graph.pages.length} page(s) (${project.config.deployment.options.output} output)`
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

    // Everything the deploy target does differently after `astro build` comes
    // off its platform (see `deploy/platforms/*`): a server build's post-build
    // step (Vercel's function-bundle audit and negotiation routes, Cloudflare's
    // wrapper Worker), and where its bundle and static assets landed.
    const { deployment } = project.config;
    const platform = deployPlatform(deployment);
    const server = deployment.options.output === "server";
    const finalize = async (isolated: boolean): Promise<void> => {
      if (
        server &&
        platform.finalizeBuild &&
        !(await platform.finalizeBuild({ isolated, log: logger, project }))
      ) {
        process.exit(1);
      }
    };

    // The bundle report and budget gate still run for an isolated build —
    // `blume build --isolated --budget-js 100` exiting 0 without measuring
    // anything would be a silent false pass in CI. An isolated build never
    // surfaces the adapter bundle to the project root, so its output dirs
    // resolve under the relocated runtime.
    if (runtimeDir) {
      await finalize(true);
      await runClientAssetChecks(
        deployStaticDir(project.config, project.context),
        args
      );
      logger.success(
        `Isolated build OK — output at ${deployOutputDir(project.config, project.context)} (not published).`
      );
      return;
    }

    // A server adapter's deploy bundle is a build artifact — keep it out of
    // version control (Vercel's own CLI ignores `.vercel/` for the same reason).
    // Ignoring it is independent of whether the bundle had to be moved below:
    // Vercel writes straight to the project root, Netlify does not.
    const { ignoreDir } = platform.hiddenRuntime;
    if (server && ignoreDir) {
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
      logger.success(`Surfaced ${deployment.kind} output to ${surfaced.to}`);
    }

    await finalize(false);

    await reportBuild(
      project,
      deployStaticDir(project.config, project.context),
      args
    );
  },
});

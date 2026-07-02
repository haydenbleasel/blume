import { existsSync } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";

import { build } from "astro";
import { defineCommand } from "citty";
import { join } from "pathe";

import { buildLlmsFiles } from "../../ai/llms.ts";
import { ensureGitignore } from "../../core/gitignore.ts";
import type { BlumeProject } from "../../core/project-graph.ts";
import type { ResolvedConfig } from "../../core/schema.ts";
import { serverFeatures } from "../../core/server-features.ts";
import {
  buildNetlifyRedirects,
  buildRedirectManifest,
  buildVercelConfig,
} from "../../deploy/redirects.ts";
import { buildRobots } from "../../deploy/robots.ts";
import { buildSitemap } from "../../deploy/sitemap.ts";
import { buildSearchIndex } from "../../search/build.ts";
import { syncSearchProvider } from "../../search/sync/index.ts";
import { refuseIfDevRunning } from "../dev-lock.ts";
import { logger } from "../log.ts";
import { prepareProject } from "../prepare.ts";

const ADAPTERS = ["vercel", "node", "netlify", "cloudflare"] as const;

/**
 * Reject a non-numeric performance budget. `Number("250kb")` is `NaN` and
 * `total > NaN` is always false, so a typo'd flag would silently pass the gate;
 * fail up front instead.
 */
const validateBudgetFlags = (args: {
  "budget-css"?: string;
  "budget-js"?: string;
}): void => {
  for (const flag of ["budget-js", "budget-css"] as const) {
    const value = args[flag];
    if (value !== undefined && !(Number(value) > 0)) {
      logger.error(
        `Invalid --${flag} "${value}" (expected a positive number of kB).`
      );
      process.exit(1);
    }
  }
};

/**
 * Emit platform redirect files for a static build (adapters wire redirects
 * natively). Always writes the manifest; writes `_redirects`/`vercel.json` only
 * when the user hasn't shipped one via public/.
 */
const emitRedirectFiles = async (
  config: ResolvedConfig,
  distDir: string
): Promise<void> => {
  const { redirects } = config;
  if (redirects.length === 0 || config.deployment.output !== "static") {
    return;
  }
  await writeFile(
    join(distDir, "blume-redirects.json"),
    buildRedirectManifest(redirects),
    "utf-8"
  );
  const platformFiles = [
    { content: buildNetlifyRedirects(redirects), name: "_redirects" },
    { content: buildVercelConfig(redirects), name: "vercel.json" },
  ];
  await Promise.all(
    platformFiles.map((file) =>
      existsSync(join(distDir, file.name))
        ? Promise.resolve()
        : writeFile(join(distDir, file.name), file.content, "utf-8")
    )
  );
  logger.success(`Emitted redirect files for ${redirects.length} redirect(s)`);
};

const formatBytes = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : `${(bytes / 1024).toFixed(bytes < 1024 * 100 ? 1 : 0)} kB`;

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
  args: { "budget-css"?: string; "budget-js"?: string }
): Promise<"fail" | "pass" | "skip"> => {
  const checks: { ext: string; limitKb: number; name: string }[] = [
    ...(args["budget-js"]
      ? [{ ext: "js", limitKb: Number(args["budget-js"]), name: "JavaScript" }]
      : []),
    ...(args["budget-css"]
      ? [{ ext: "css", limitKb: Number(args["budget-css"]), name: "CSS" }]
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
 * Run every deploy post-step of a real (non-isolated) build: the search index +
 * hosted-provider sync, llms.txt, sitemap/robots, redirect files, the summary
 * box, and the optional bundle report / budget gate. Exits non-zero if a budget
 * is exceeded. Isolated verify builds skip all of this.
 */
const publishBuildArtifacts = async (
  project: BlumeProject,
  distDir: string,
  args: { analyze?: boolean; "budget-css"?: string; "budget-js"?: string }
): Promise<void> => {
  if (project.config.search.provider === "pagefind") {
    logger.start("Building search index");
    const indexed = await buildSearchIndex(distDir);
    logger.success(`Indexed ${indexed} page(s) for search`);
  }

  // Upload the index to a hosted provider (Algolia, Orama Cloud, Typesense).
  // Skipped with a warning when its admin key isn't configured.
  await syncSearchProvider(project, {
    start: (message) => logger.start(message),
    success: (message) => logger.success(message),
    warn: (message) => logger.warn(message),
  });

  if (project.config.ai.llmsTxt) {
    const { index, full } = await buildLlmsFiles(project);
    await Promise.all([
      writeFile(join(distDir, "llms.txt"), index, "utf-8"),
      writeFile(join(distDir, "llms-full.txt"), full, "utf-8"),
    ]);
    logger.success("Generated llms.txt and llms-full.txt");
  }

  // A user's own public/ file (copied into dist by Astro) always wins.
  const sitemap = buildSitemap(project);
  if (sitemap && !existsSync(join(distDir, "sitemap.xml"))) {
    await writeFile(join(distDir, "sitemap.xml"), sitemap, "utf-8");
    logger.success("Generated sitemap.xml");
  }

  const robots = buildRobots(project);
  if (robots && !existsSync(join(distDir, "robots.txt"))) {
    await writeFile(join(distDir, "robots.txt"), robots, "utf-8");
    logger.success("Generated robots.txt");
  }

  await emitRedirectFiles(project.config, distDir);

  const { config } = project;
  const features = serverFeatures(config);
  logger.box(
    [
      `Output     ${config.deployment.output}`,
      `Adapter    ${config.deployment.adapter ?? "none"}`,
      `Site       ${config.deployment.site ?? "not set"}`,
      `Search     ${config.search.provider}`,
      `Redirects  ${config.redirects.length}`,
      `Sitemap    ${sitemap ? "yes" : "no (set deployment.site)"}`,
      `Robots     ${robots ? "yes" : "no"}`,
      `LLM files  ${config.ai.llmsTxt ? "yes" : "no"}`,
      `Server features  ${features.length > 0 ? features.join(", ") : "none"}`,
    ].join("\n")
  );

  if (args.analyze) {
    await reportBundleSizes(distDir);
  }

  if ((await enforceBudget(distDir, args)) === "fail") {
    process.exit(1);
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
    "budget-css": {
      description: "Fail if total client CSS exceeds this many kB.",
      type: "string",
    },
    "budget-js": {
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
    strict: { description: "Fail on diagnostics.", type: "boolean" },
  },
  meta: {
    description: "Build the docs site for production.",
    name: "build",
  },
  async run({ args }) {
    const root = process.cwd();

    // `--isolated` (or BLUME_RUNTIME_DIR) relocates the whole runtime to a
    // sibling dir so this build never touches a live dev server's `.blume/` or
    // the user's real `dist/`. A non-default runtime dir has no dev lock, so the
    // refusal below lets it proceed; a plain build still refuses.
    const runtimeDir = args.isolated
      ? ".blume-verify"
      : process.env.BLUME_RUNTIME_DIR;
    refuseIfDevRunning(root, "building", runtimeDir);
    if (args.isolated) {
      await ensureGitignore(root, [".blume-verify/"]);
    }

    if (args.output && args.output !== "static" && args.output !== "server") {
      logger.error(`Invalid --output "${args.output}" (use static | server).`);
      process.exit(1);
    }
    if (args.adapter && !ADAPTERS.includes(args.adapter as never)) {
      logger.error(
        `Invalid --adapter "${args.adapter}" (use ${ADAPTERS.join(" | ")}).`
      );
      process.exit(1);
    }
    validateBudgetFlags(args);

    const project = await prepareProject({
      mode: "build",
      overrides: {
        adapter: args.adapter as (typeof ADAPTERS)[number] | undefined,
        base: args.base,
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

    await build({
      logLevel: "info",
      root: project.context.outDir,
    });

    const distDir = project.context.distDir ?? join(root, "dist");

    // An isolated build is a throwaway verify: it only needs to confirm the site
    // compiles and renders. Skip the network post-steps (search sync) and
    // deploy artifacts (index/llms/sitemap/robots/redirects) that only matter
    // for a real publish and would push to hosted providers.
    if (runtimeDir) {
      logger.success(
        `Isolated build OK — output at ${distDir} (not published).`
      );
      return;
    }

    await publishBuildArtifacts(project, distDir, args);
  },
});

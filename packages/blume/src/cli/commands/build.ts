import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";

import { build } from "astro";
import { defineCommand } from "citty";
import { dirname, join, resolve } from "pathe";

import { buildAgentReadability } from "../../ai/agent-readability.ts";
import {
  API_CATALOG_PATH,
  API_CATALOG_TYPE,
  buildApiCatalog,
  hasApiCatalog,
} from "../../ai/api-catalog.ts";
import { buildHomeLinkHeader } from "../../ai/link-headers.ts";
import { buildLlmsFiles } from "../../ai/llms.ts";
import {
  agentMarkdown,
  buildRawMarkdown,
  markdownRoutePaths,
  markdownTokenCount,
} from "../../ai/markdown.ts";
import {
  AGENT_SKILLS_DIR,
  buildSkillsIndex,
  collectSkills,
} from "../../ai/skills.ts";
import {
  buildSignaturesDirectory,
  SIGNATURES_DIRECTORY_PATH,
  SIGNATURES_DIRECTORY_TYPE,
} from "../../ai/web-bot-auth.ts";
import { ensureGitignore } from "../../core/gitignore.ts";
import type { BlumeProject } from "../../core/project-graph.ts";
import type { ResolvedConfig } from "../../core/schema.ts";
import { serverFeatures } from "../../core/server-features.ts";
import type { ProjectContext } from "../../core/types.ts";
import {
  ADAPTER_IGNORE_DIRS,
  deployStaticDir,
  readsHeaderFiles,
  servesClientSubdir,
  surfaceAdapterOutput,
} from "../../deploy/adapter-output.ts";
import { buildNetlifyHeaders } from "../../deploy/headers.ts";
import {
  applyBaseToPlatformRedirects,
  buildNetlifyRedirects,
  buildRedirectManifest,
  buildVercelConfig,
} from "../../deploy/redirects.ts";
import { buildRobots } from "../../deploy/robots.ts";
import { buildSitemap } from "../../deploy/sitemap.ts";
import { injectNegotiationRoutes } from "../../deploy/vercel-negotiation.ts";
import { buildSearchIndex } from "../../search/build.ts";
import { syncSearchProvider } from "../../search/sync/index.ts";
import { refuseIfDevRunning } from "../dev-lock.ts";
import { logger } from "../log.ts";
import { prepareProject } from "../prepare.ts";

const ADAPTERS = ["vercel", "node", "netlify", "cloudflare"] as const;

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
 * Emit platform redirect files for a static build (adapters wire redirects
 * natively). Always writes the manifest; writes `_redirects`/`vercel.json` only
 * when the user hasn't shipped one via public/. Note that Vercel's
 * git-integration builds read `vercel.json` from the repository root only —
 * the copy emitted here takes effect when the dist folder itself is deployed
 * directly via the Vercel CLI.
 */
const emitRedirectFiles = async (
  config: ResolvedConfig,
  distDir: string
): Promise<void> => {
  const redirects = applyBaseToPlatformRedirects(
    config.redirects,
    config.basePath,
    config.deployment.base ?? ""
  );
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

/**
 * Emit a `_headers` file so Netlify / Cloudflare serve the raw AI-ready
 * endpoints (`*.md`, `*.mdx`, `*.txt`) with an explicit `charset=utf-8`. Without
 * it those hosts send `text/markdown` / `text/plain` with no charset and
 * browsers fall back to Windows-1252, garbling any non-ASCII docs (#82).
 *
 * The same file carries the rest of the agent-discovery surface that only a
 * response header can express: the homepage `Link` header (RFC 8288, see
 * `ai/link-headers.ts`), and the registered media types for the extensionless
 * well-known files — `application/linkset+json` for the API catalog, the
 * signatures directory, and the Agent Skills archives. A static host serves
 * those as `octet-stream` or nothing at all without a rule.
 *
 * A `_headers` shipped in `public/` wins, exactly like `_redirects` — the opt-out
 * is checked at its source rather than in `dist`, because on Cloudflare the file
 * in `dist` is not necessarily the user's: `@astrojs/cloudflare` writes its own
 * `_headers` (an immutable `Cache-Control` rule for `/_astro/*`) during the
 * build, before this runs. Testing `dist` therefore read an adapter-generated
 * file as a user opt-out and skipped silently. When both exist, the adapter's
 * rules are preserved and ours are appended.
 *
 * Gated on {@link readsHeaderFiles}, not on `output === "static"`. A **Cloudflare
 * server** build serves `dist/client` through the Worker's ASSETS binding, and
 * Workers static assets honour `_headers` from that directory — so the file
 * applies there too, and skipping it left every Cloudflare server build with no
 * `Link` header and no media type on its own discovery files. The charset half
 * of this file *is* redundant on a server build, because the runtime endpoint
 * sets Content-Type on the Response itself; the `Link` and well-known halves are
 * not, and one conclusion about the first was applied to all three.
 */
const emitHeaderFiles = async (
  project: BlumeProject,
  distDir: string
): Promise<void> => {
  const { config } = project;
  if (
    !readsHeaderFiles(config.deployment) ||
    existsSync(join(project.context.root, "public", "_headers"))
  ) {
    return;
  }
  const ours = buildNetlifyHeaders(
    config,
    buildHomeLinkHeader(config, markdownRoutePaths(project))
  );
  // An adapter may have written its own rules here already (Cloudflare adds an
  // immutable Cache-Control for /_astro/*). Keep them and append ours: both
  // sets are wanted, and `_headers` has no merge semantics beyond order.
  const target = join(distDir, "_headers");
  const existing = existsSync(target) ? await readFile(target, "utf-8") : "";
  await writeFile(
    target,
    existing ? `${existing.trimEnd()}\n${ours}` : ours,
    "utf-8"
  );
  logger.success(
    "Emitted _headers (UTF-8 Content-Type + homepage Link header)"
  );
};

/**
 * Publish the configured Agent Skills: copy each skill artifact under
 * `.well-known/agent-skills/` and emit the discovery index. A user-shipped
 * `public/.well-known/agent-skills/index.json` takes over the whole surface,
 * matching every other generated artifact.
 */
const emitAgentSkills = async (
  project: BlumeProject,
  distDir: string
): Promise<void> => {
  const configured = project.config.ai.skills;
  if (!configured) {
    return;
  }
  const dir = resolve(project.context.root, configured);
  if (!existsSync(dir)) {
    logger.warn(
      `ai.skills points at "${configured}" (${dir}), which does not exist; no skills published.`
    );
    return;
  }
  const outDir = join(distDir, AGENT_SKILLS_DIR.slice(1));
  if (existsSync(join(outDir, "index.json"))) {
    return;
  }
  const { skills, warnings } = await collectSkills(dir);
  for (const warning of warnings) {
    logger.warn(warning);
  }
  if (skills.length === 0) {
    logger.warn(`ai.skills: no publishable skills found in "${configured}".`);
    return;
  }
  await Promise.all(
    skills.map(async (skill) => {
      const target = join(outDir, skill.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, skill.content);
    })
  );
  await writeFile(
    join(outDir, "index.json"),
    buildSkillsIndex(skills, project.config),
    "utf-8"
  );
  logger.success(
    `Published ${skills.length} agent skill(s) (.well-known/agent-skills/index.json)`
  );
};

/**
 * Emit the generated `.well-known` discovery files — the RFC 9727 API catalog
 * and the Web Bot Auth signature directory — each skipped when the feature is
 * off or when the user ships their own copy via public/ (already in dist by
 * the time this runs).
 */
const emitWellKnownFiles = async (
  config: ResolvedConfig,
  distDir: string
): Promise<void> => {
  const files = [
    {
      content: buildSignaturesDirectory(config),
      label: "Web Bot Auth",
      path: SIGNATURES_DIRECTORY_PATH,
    },
    {
      content: buildApiCatalog(config),
      label: "RFC 9727",
      path: API_CATALOG_PATH,
    },
  ];
  for (const file of files) {
    const target = join(distDir, file.path.slice(1));
    if (!file.content || existsSync(target)) {
      continue;
    }
    // Sequential by nature: both files share the .well-known dir creation.
    // oxlint-disable-next-line no-await-in-loop
    await mkdir(join(distDir, ".well-known"), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop
    await writeFile(target, file.content, "utf-8");
    logger.success(`Generated ${file.path.slice(1)} (${file.label})`);
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
  const overrides: Record<string, string> = {
    ...(hasApiCatalog(config)
      ? { [API_CATALOG_PATH.slice(1)]: API_CATALOG_TYPE }
      : {}),
    ...(config.ai.webBotAuth.keys.length > 0
      ? { [SIGNATURES_DIRECTORY_PATH.slice(1)]: SIGNATURES_DIRECTORY_TYPE }
      : {}),
  };
  // The homepage rewrite serves `/index.md` from the static layer, so its
  // `x-markdown-tokens` estimate has to ride the routing config; the runtime
  // endpoint stamps it on dev/server-rendered responses itself.
  const rawMarkdown = await buildRawMarkdown(project);
  const home = rawMarkdown["/"];
  const injected = injectNegotiationRoutes(
    await readFile(configPath, "utf-8"),
    routePaths,
    buildHomeLinkHeader(config, routePaths),
    overrides,
    home ? markdownTokenCount(agentMarkdown(home)) : undefined
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
 * Generate `llms.txt`/`llms-full.txt` into the dist dir. A user's own file in
 * `public/` (copied into dist by Astro before this runs, like the sitemap and
 * robots.txt) wins over the generated one — each file is checked and replaced
 * independently, so a custom `llms.txt` still gets a generated `llms-full.txt`.
 */
const publishLlmsFiles = async (
  project: BlumeProject,
  distDir: string
): Promise<void> => {
  const indexPath = join(distDir, "llms.txt");
  const fullPath = join(distDir, "llms-full.txt");
  const writeIndex = !existsSync(indexPath);
  const writeFull = !existsSync(fullPath);
  if (!(writeIndex || writeFull)) {
    return;
  }
  const { index, full } = await buildLlmsFiles(project);
  const writes: Promise<void>[] = [];
  if (writeIndex) {
    writes.push(writeFile(indexPath, index, "utf-8"));
  }
  if (writeFull) {
    writes.push(writeFile(fullPath, full, "utf-8"));
  }
  await Promise.all(writes);
  logger.success(
    `Generated ${[
      writeIndex ? "llms.txt" : null,
      writeFull ? "llms-full.txt" : null,
    ]
      .filter(Boolean)
      .join(" and ")}`
  );
};

/**
 * Run every deploy post-step of a real (non-isolated) build: the search index +
 * hosted-provider sync, llms.txt, sitemap/robots, redirect files, the summary
 * box, and the optional bundle report / budget gate. Exits non-zero if a budget
 * is exceeded. Isolated verify builds skip all of this except the bundle
 * report / budget gate, which they run against their own output.
 */
const publishBuildArtifacts = async (
  project: BlumeProject,
  distDir: string,
  args: { analyze?: boolean } & BudgetArgs
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

  if (project.config.ai.llmsTxt.enabled) {
    await publishLlmsFiles(project, distDir);
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

  const agentReadability = buildAgentReadability(project);
  if (
    agentReadability &&
    !existsSync(join(distDir, "agent-readability.json"))
  ) {
    await writeFile(
      join(distDir, "agent-readability.json"),
      `${JSON.stringify(agentReadability, null, 2)}\n`,
      "utf-8"
    );
    logger.success("Generated agent-readability.json");
  }

  await emitWellKnownFiles(project.config, distDir);
  await emitAgentSkills(project, distDir);

  await emitRedirectFiles(project.config, distDir);
  await emitHeaderFiles(project, distDir);

  const { config } = project;
  const features = serverFeatures(config);
  // `buildSitemap` returns null both when the sitemap is disabled and when no
  // `site` is configured — only the latter deserves the remediation hint.
  const sitemapNote = config.seo.sitemap
    ? "no (set deployment.site)"
    : "no (seo.sitemap is false)";
  logger.box(
    [
      `Output     ${config.deployment.output}`,
      `Adapter    ${config.deployment.adapter ?? "none"}`,
      `Site       ${config.deployment.site ?? "not set"}`,
      `Search     ${config.search.provider}`,
      `Redirects  ${config.redirects.length}`,
      `Sitemap    ${sitemap ? "yes" : sitemapNote}`,
      `Robots     ${robots ? "yes" : "no"}`,
      `Agent JSON ${agentReadability ? "yes" : "no"}`,
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
    refuseIfDevRunning(root, "building", { isolatedHint: true, runtimeDir });
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

    // An isolated build is a throwaway verify: it only needs to confirm the site
    // compiles and renders. Skip the network post-steps (search sync) and
    // deploy artifacts (index/llms/sitemap/robots/redirects) that only matter
    // for a real publish and would push to hosted providers. The bundle report
    // and budget gate still run, though — `blume build --isolated --budget-js
    // 100` exiting 0 without measuring anything would be a silent false pass
    // in CI.
    if (runtimeDir) {
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
      await emitVercelNegotiation(project, markdownRoutePaths(project), root);
    }

    await publishBuildArtifacts(
      project,
      deployStaticDir(project.config, project.context),
      args
    );
  },
});

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import { build } from "astro";
import { defineCommand } from "citty";
import { join } from "pathe";

import { writeLlmsArtifacts } from "../../ai/llms.ts";
import { writeChangelogRssFeeds } from "../../changelog/rss.ts";
import { serverFeatures } from "../../core/server-features.ts";
import { buildRobots } from "../../deploy/robots.ts";
import { buildSitemap } from "../../deploy/sitemap.ts";
import { buildSearchIndex } from "../../search/build.ts";
import { syncSearchProvider } from "../../search/sync/index.ts";
import { logger } from "../log.ts";
import { prepareProject } from "../prepare.ts";

export const runBuild = async (options: { strict?: boolean } = {}) => {
  const root = process.cwd();
  const project = await prepareProject({
    mode: "build",
    root,
    strict: options.strict,
  });

  logger.start(
    `Building ${project.graph.pages.length} page(s) (${project.config.deployment.output} output)`
  );

  await build({
    logLevel: "info",
    root: project.context.outDir,
  });

  const distDir = join(root, "dist");

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
    const { markdownPages } = await writeLlmsArtifacts(project, distDir);
    logger.success(
      `Generated llms.txt, llms-full.txt, skill.md, and ${markdownPages} Markdown page export(s)`
    );
  }

  const rssFeeds = await writeChangelogRssFeeds(project, distDir);
  if (rssFeeds > 0) {
    logger.success(`Generated ${rssFeeds} changelog RSS feed(s)`);
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

  const { config } = project;
  const features = serverFeatures(config);
  logger.box(
    [
      `Output     ${config.deployment.output}`,
      `Adapter    ${config.deployment.adapter ?? "none"}`,
      `Search     ${config.search.provider}`,
      `Redirects  ${config.redirects.length}`,
      `Sitemap    ${sitemap ? "yes" : "no (set deployment.site)"}`,
      `Robots     ${robots ? "yes" : "no"}`,
      `LLM files  ${config.ai.llmsTxt ? "yes" : "no"}`,
      `Server features  ${features.length > 0 ? features.join(", ") : "none"}`,
    ].join("\n")
  );

  logger.success(`Built to ${distDir}`);
};

export const buildCommand = defineCommand({
  args: {
    strict: { description: "Fail on diagnostics.", type: "boolean" },
  },
  meta: {
    description: "Build the docs site for production.",
    name: "build",
  },
  async run({ args }) {
    await runBuild({ strict: args.strict });
    process.exit(0);
  },
});

import { writeFile } from "node:fs/promises";

import { build } from "astro";
import { defineCommand } from "citty";
import { join } from "pathe";

import { writeLlmsArtifacts } from "../../ai/llms.ts";
import { writeChangelogRssFeeds } from "../../changelog/rss.ts";
import { serverFeatures } from "../../core/server-features.ts";
import { buildSitemap } from "../../deploy/sitemap.ts";
import { buildSearchIndex } from "../../search/build.ts";
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

  const sitemap = buildSitemap(project);
  if (sitemap) {
    await writeFile(join(distDir, "sitemap.xml"), sitemap, "utf-8");
    logger.success("Generated sitemap.xml");
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

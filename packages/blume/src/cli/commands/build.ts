import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import { build } from "astro";
import { defineCommand } from "citty";
import { join } from "pathe";

import { buildLlmsFiles } from "../../ai/llms.ts";
import { serverFeatures } from "../../core/server-features.ts";
import { buildRobots } from "../../deploy/robots.ts";
import { buildSitemap } from "../../deploy/sitemap.ts";
import { buildSearchIndex } from "../../search/build.ts";
import { syncSearchProvider } from "../../search/sync/index.ts";
import { logger } from "../log.ts";
import { prepareProject } from "../prepare.ts";

export const buildCommand = defineCommand({
  args: {
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
    const project = await prepareProject({
      mode: "build",
      preview: args.preview,
      root,
      strict: args.strict,
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

    logger.success(`Built to ${distDir}`);
  },
});

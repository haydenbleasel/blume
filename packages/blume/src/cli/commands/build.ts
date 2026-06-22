import { build } from "astro";
import { defineCommand } from "citty";
import { join } from "pathe";

import { logger } from "../log.ts";
import { prepareProject } from "../prepare.ts";

export const buildCommand = defineCommand({
  args: {
    strict: { description: "Fail on diagnostics.", type: "boolean" },
  },
  meta: {
    description: "Build the docs site for production.",
    name: "build",
  },
  async run({ args }) {
    const root = process.cwd();
    const project = await prepareProject({ root, strict: args.strict });

    logger.start(
      `Building ${project.graph.pages.length} page(s) (${project.config.deployment.output} output)`
    );

    await build({
      logLevel: "info",
      root: project.context.outDir,
    });

    logger.success(`Built to ${join(root, "dist")}`);
  },
});

import { watch } from "node:fs";

import { dev } from "astro";
import { defineCommand } from "citty";

import { generateRuntime } from "../../astro/generate.ts";
import { scanProject } from "../../core/project-graph.ts";
import { logger } from "../log.ts";
import { prepareProject } from "../prepare.ts";

export const devCommand = defineCommand({
  args: {
    host: { description: "Network host to bind.", type: "string" },
    open: { description: "Open the browser on start.", type: "boolean" },
    port: { description: "Port to listen on.", type: "string" },
    preview: {
      description: "Include drafts and unpublished CMS content.",
      type: "boolean",
    },
    strict: { description: "Fail on diagnostics.", type: "boolean" },
  },
  meta: {
    description: "Start the Blume development server.",
    name: "dev",
  },
  async run({ args }) {
    const root = process.cwd();
    const preview = args.preview ?? false;
    // Astro's dev server defaults to 4321 when no port is passed. Feeding the
    // resolved URL in as the `deployment.site` fallback lets site-gated features
    // (OG images, canonicals, sitemap) work locally without configuring a site.
    const port = args.port ? Number(args.port) : 4321;
    const devServerUrl = `http://localhost:${port}`;
    const project = await prepareProject({
      devServerUrl,
      mode: "dev",
      preview,
      root,
      strict: args.strict,
    });

    const server = await dev({
      logLevel: "info",
      root: project.context.outDir,
      server: {
        host: args.host ?? false,
        open: args.open ?? false,
        port: args.port ? Number(args.port) : undefined,
      },
    });

    // Watch user inputs and regenerate the runtime data on change. Astro/Vite
    // hot-reloads the generated data module so nav and routes stay in sync.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const regenerate = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(async () => {
        try {
          const next = await scanProject(root, {
            devServerUrl,
            mode: "dev",
            preview,
          });
          await generateRuntime(next);
        } catch (error) {
          logger.error(`Regeneration failed: ${(error as Error).message}`);
        }
      }, 80);
    };

    // Content is watched per source (filesystem uses fs.watch; remote sources
    // are frozen for the session). The remaining project inputs — user pages,
    // config, theme, and component overrides — are watched directly.
    const fileTargets = [
      project.context.pagesRoot,
      project.context.configFile,
      project.context.themeFile,
      project.context.componentsFile,
    ].filter((target) => target !== null);

    const disposers = [
      ...project.sources.map((source) => source.watch?.(regenerate)),
      ...fileTargets.map((target) => {
        const watcher = watch(target, { recursive: true }, regenerate);
        return () => watcher.close();
      }),
    ].filter((dispose) => dispose !== undefined);

    const shutdown = async () => {
      for (const dispose of disposers) {
        dispose();
      }
      await server.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  },
});

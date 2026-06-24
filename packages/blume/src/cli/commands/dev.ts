import { watch } from "node:fs";

import { dev } from "astro";
import { defineCommand } from "citty";

import { generateRuntime } from "../../astro/generate.ts";
import { scanProject } from "../../core/project-graph.ts";
import { logger } from "../log.ts";
import { prepareProject } from "../prepare.ts";

const ignoredWatchSegments = new Set([
  ".blume",
  ".git",
  "build",
  "dist",
  "node_modules",
]);

const shouldIgnoreWatchEvent = (
  filename: Buffer<ArrayBufferLike> | string | null
): boolean => {
  if (!filename) {
    return false;
  }
  const value = filename.toString();
  return value
    .split(/[\\/]/u)
    .some((segment) => ignoredWatchSegments.has(segment));
};

export const devCommand = defineCommand({
  args: {
    host: { description: "Network host to bind.", type: "string" },
    open: { description: "Open the browser on start.", type: "boolean" },
    port: { description: "Port to listen on.", type: "string" },
    strict: { description: "Fail on diagnostics.", type: "boolean" },
  },
  meta: {
    description: "Start the Blume development server.",
    name: "dev",
  },
  async run({ args }) {
    const root = process.cwd();
    const project = await prepareProject({
      mode: "dev",
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
    const watchTargets = [
      project.context.contentRoot,
      project.context.pagesRoot,
      project.context.configFile,
      ...project.context.themeFiles,
      project.context.componentsFile,
    ].filter((target) => target !== null);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const regenerate = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(async () => {
        try {
          const next = await scanProject(root, { mode: "dev" });
          await generateRuntime(next);
        } catch (error) {
          logger.error(`Regeneration failed: ${(error as Error).message}`);
        }
      }, 80);
    };

    const watchers = watchTargets.map((target) =>
      watch(target, { recursive: true }, (_event, filename) => {
        if (!shouldIgnoreWatchEvent(filename)) {
          regenerate();
        }
      })
    );

    const shutdown = async () => {
      for (const w of watchers) {
        w.close();
      }
      await server.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  },
});

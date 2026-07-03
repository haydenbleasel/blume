import { watch } from "node:fs";

import { dev } from "astro";
import { defineCommand } from "citty";

import { generateRuntime } from "../../astro/generate.ts";
import { showBlumeErrorOverlay } from "../../astro/integration.ts";
import { scanProject } from "../../core/project-graph.ts";
import { parsePort } from "../args.ts";
import { coalescedRunner } from "../coalesce.ts";
import { acquireDevLock, isDevLocked } from "../dev-lock.ts";
import { logger } from "../log.ts";
import { prepareProject } from "../prepare.ts";

export const devCommand = defineCommand({
  args: {
    "content-dir": {
      description: "Content folder to scan, overriding config (content.root).",
      type: "string",
    },
    debug: {
      description: "Verbose Astro/Vite logging for troubleshooting.",
      type: "boolean",
    },
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
    const overrides = args["content-dir"]
      ? { contentRoot: args["content-dir"] }
      : undefined;
    // Astro's dev server defaults to 4321 when no port is passed. Feeding the
    // resolved URL in as the `deployment.site` fallback lets site-gated features
    // (OG images, canonicals, sitemap) work locally without configuring a site.
    const explicitPort = parsePort(args.port);
    const port = explicitPort ?? 4321;
    const devServerUrl = `http://localhost:${port}`;
    const project = await prepareProject({
      devServerUrl,
      mode: "dev",
      overrides,
      preview,
      root,
      strict: args.strict,
    });

    if (project.bridge) {
      logger.info(
        'Detected docs.json — running in Mintlify bridge mode (no migration). Run "blume migrate mintlify" to convert permanently.'
      );
    }

    // Claim the shared `.blume` dir so a concurrent build/eject/sync refuses
    // rather than regenerating or deleting it out from under this server. A
    // second dev server would fight over the same generated tree the same
    // way, so it must refuse too instead of silently clobbering the lock.
    if (isDevLocked(project.context.outDir)) {
      logger.error(
        "Another `blume dev` is already running in this project; two dev servers would corrupt the shared .blume dir. Stop the other one first (or delete .blume/dev.lock if it crashed)."
      );
      process.exit(1);
    }
    const releaseLock = acquireDevLock(project.context.outDir);
    process.on("exit", releaseLock);

    const server = await dev({
      logLevel: args.debug ? "debug" : "info",
      root: project.context.outDir,
      server: {
        host: args.host ?? false,
        open: args.open ?? false,
        port: explicitPort,
      },
    });

    // Mirror any initial diagnostics into the browser overlay now the server
    // (and its HMR channel) is up.
    showBlumeErrorOverlay(project.diagnostics);

    // Watch user inputs and regenerate the runtime data on change. Astro/Vite
    // hot-reloads the generated data module so nav and routes stay in sync.
    // `coalescedRunner` single-flights the scan so a burst of watch events can
    // never stack overlapping regenerations (a large project's scan can outlast
    // the debounce; piled-up scans exhaust the heap).
    const runRegenerate = coalescedRunner(async () => {
      try {
        const next = await scanProject(root, {
          devServerUrl,
          mode: "dev",
          overrides,
          preview,
        });
        await generateRuntime(next);
        // Surface any content/config errors in the browser overlay too.
        showBlumeErrorOverlay(next.diagnostics);
      } catch (error) {
        logger.error(`Regeneration failed: ${(error as Error).message}`);
      }
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    const regenerate = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(runRegenerate, 80);
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
      releaseLock();
      await server.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  },
});

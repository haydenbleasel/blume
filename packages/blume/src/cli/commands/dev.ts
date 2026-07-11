import { watch } from "node:fs";

import { dev } from "astro";
import { defineCommand } from "citty";

import { generateRuntime } from "../../astro/generate.ts";
import { showBlumeErrorOverlay } from "../../astro/integration.ts";
import { scanProject } from "../../core/project-graph.ts";
import { resolveRuntimeDir } from "../../core/project.ts";
import { parsePort } from "../args.ts";
import { coalescedRunner } from "../coalesce.ts";
import {
  acquireDevLock,
  describeDevLock,
  DevLockHeldError,
  updateDevLockPort,
} from "../dev-lock.ts";
import { logger, reportDiagnostics } from "../log.ts";
import { prepareProject } from "../prepare.ts";

/**
 * Resolve a `--host` flag value into what Astro/Vite's `server.host` expects.
 * citty (0.1) has no mixed string/boolean arg type, so `host` is declared as a
 * string and a bare `--host` parses as `""` — Node would bind all interfaces
 * for `""`, but Vite's `resolveHostname` treats it as a literal hostname and
 * prints malformed URLs like `http://:4321/`. Match Astro's own `--host`
 * semantics instead: bare flag → `true` (bind all interfaces), `--host
 * 10.0.0.1` → that address, absent → `false` (localhost only).
 */
export const normalizeHost = (host: string | undefined): boolean | string =>
  host === "" ? true : (host ?? false);

/**
 * A fingerprint of the route set: the sorted `path entryId` pairs. It changes
 * when a page is added, removed, or renamed (a folder rename shifts many at
 * once) but stays equal across pure body edits — so the dev loop can tell a
 * "structural" change (needs a cold restart) from a hot-reloadable one.
 */
const routeSignature = (
  routes: readonly { entryId: string; path: string }[]
): string =>
  routes
    .map((route) => `${route.path} ${route.entryId}`)
    .toSorted()
    .join("\n");

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
    let devServerUrl = `http://localhost:${port}`;

    // Claim the shared `.blume` dir BEFORE preparing: `prepareProject`
    // regenerates the runtime, so even a refused second dev server would
    // otherwise clobber the running one's generated tree (with this
    // invocation's port baked in) on its way out. The claim is atomic, so two
    // simultaneous starts can't both win. Dev never relocates the runtime dir,
    // so the lock always lives at `<root>/.blume`.
    const outDir = resolveRuntimeDir(root);
    let releaseLock: () => void;
    try {
      releaseLock = acquireDevLock(outDir, port);
    } catch (error) {
      if (error instanceof DevLockHeldError) {
        logger.error(
          `A \`blume dev\` server is already running${describeDevLock(error.lock)} in this project. Reuse that server instead of starting a second one — two dev servers would corrupt the shared .blume dir. If it crashed, delete .blume/dev.lock.`
        );
        process.exit(1);
      }
      throw error;
    }
    process.on("exit", releaseLock);

    const project = await prepareProject({
      devServerUrl,
      mode: "dev",
      overrides,
      preview,
      root,
      strict: args.strict,
    });

    // A factory so `runRegenerate` can recreate the server on a structural
    // (route-set) change: only a cold container re-globs Astro's content store,
    // which its in-place config restart doesn't. `open` is honoured on first
    // boot only — a restart must not reopen the browser.
    const createServer = (listenPort: number | undefined, open: boolean) =>
      dev({
        logLevel: args.debug ? "debug" : "info",
        root: project.context.outDir,
        server: { host: normalizeHost(args.host), open, port: listenPort },
      });

    let server = await createServer(explicitPort, args.open ?? false);

    // Vite bumps to the next free port when the default is taken, so record
    // the port the server actually bound — the lock's URL is what a refused
    // second invocation tells its caller to reuse. The site fallback baked
    // into the runtime also carries the port, so it must follow suit (below,
    // once the regeneration closure exists).
    const boundPort = server.address.port;
    if (boundPort !== port) {
      updateDevLockPort(outDir, boundPort);
      devServerUrl = `http://localhost:${boundPort}`;
    }

    // Mirror any initial diagnostics into the browser overlay now the server
    // (and its HMR channel) is up.
    showBlumeErrorOverlay(project.diagnostics);

    let lastSignature = routeSignature(project.manifest.routes);

    // Watch user inputs and regenerate the runtime data on change. A body edit
    // hot-reloads via Vite (fast path). A route-set change instead forces a cold
    // server restart: Astro's in-place content sync never re-globs on a Blume
    // route change (it strips `integrations` from its cache digest) and its glob
    // watcher misses directory renames, so a renamed page 404s (`getEntry` reads
    // a stale in-memory store) until the server is restarted. We restart it
    // ourselves — stop, regenerate while down (no watcher races), then bring up
    // a fresh container whose cold sync re-globs everything. `coalescedRunner`
    // single-flights the scan so a burst of watch events can never stack
    // overlapping regenerations (piled-up scans exhaust the heap).
    const runRegenerate = coalescedRunner(async () => {
      try {
        const next = await scanProject(root, {
          devServerUrl,
          mode: "dev",
          overrides,
          preview,
        });
        const nextSignature = routeSignature(next.manifest.routes);
        const structural = nextSignature !== lastSignature;
        if (structural) {
          await server.stop();
          await generateRuntime(next);
          server = await createServer(boundPort, false);
        } else {
          await generateRuntime(next);
        }
        // Commit the signature only after the (re)generation succeeded. If the
        // restart above throws mid-sequence, the signature stays stale so the
        // next watch event retries the structural path — committing early would
        // route it to the non-structural branch with the server still down.
        lastSignature = nextSignature;
        // Surface any content/config errors in the terminal AND the browser
        // overlay. The terminal report must not be skipped: on a published
        // install the CLI bundle holds its own copy of the integration module,
        // separate from the Vite module graph that registers the overlay, so
        // the overlay call below can be a no-op there.
        reportDiagnostics(next.diagnostics, root);
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

    // The runtime prepared above baked the *requested* port into the site
    // fallback; if Vite bumped it, regenerate so OG images, canonicals, and
    // other site-gated URLs point at the port actually serving.
    if (boundPort !== port) {
      void runRegenerate();
    }

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

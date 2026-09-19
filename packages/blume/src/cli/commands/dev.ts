import { dev } from "astro";
import { watch } from "chokidar";
import { defineCommand } from "citty";
import { debounce } from "perfect-debounce";

import { generateRuntime } from "../../astro/generate.ts";
import {
  refreshBlumeContent,
  showBlumeErrorOverlay,
} from "../../astro/integration.ts";
import { BlumeError } from "../../core/diagnostics.ts";
import { scanProject } from "../../core/project-graph.ts";
import { resolveRuntimeDir } from "../../core/project.ts";
import { parsePort } from "../args.ts";
import { commandMeta } from "../command-meta.ts";
import {
  acquireDevLock,
  describeDevLock,
  DevLockHeldError,
  updateDevLockPort,
} from "../dev-lock.ts";
import { normalizeHost } from "../host-args.ts";
import { logger, reportDiagnostics } from "../log.ts";
import { prepareProject } from "../prepare.ts";

/**
 * A fingerprint of the route set: the sorted `path entryId` pairs. It changes
 * when a page is added, removed, or renamed (a folder rename shifts many at
 * once) but stays equal across pure body edits — so the dev loop can tell a
 * "structural" change (needs a content re-sync) from a hot-reloadable one.
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
  meta: commandMeta.dev,
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

    // A factory so the regenerate loop can recreate the server when a
    // structural (route-set) change can't be re-synced in place (see below).
    // `open` is honored on first boot only — a restart must not reopen the
    // browser.
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
    // hot-reloads via Vite (fast path). A route-set change also needs Astro's
    // content store re-synced: its glob watcher misses directory renames, so a
    // renamed page would 404 (`getEntry` reads a stale store). Astro hands the
    // integration `refreshContent` for exactly that — a full loader run
    // against the live server, after which Astro's own store watcher clears
    // the route cache and reloads the browser. Only a server that registered
    // no refresh (none since Astro 5) falls back to a cold restart: stop,
    // then bring up a fresh container whose cold sync re-globs everything.
    // perfect-debounce both debounces the watch burst (80ms) and
    // single-flights the scan: a
    // trigger during a run never starts a second run, only marks one trailing
    // rerun after the current settles. Both halves are load-bearing — a plain
    // debounce once let bursts stack overlapping scans until the heap was
    // exhausted (observed as an OOM after minutes of looping). The contract is
    // pinned by test/dev-debounce.test.ts. The task must not reject (the
    // library re-invokes it from an unhandled .finally), so the body catches
    // its own errors and always resolves.
    const regenerate = debounce(async () => {
      try {
        const next = await scanProject(root, {
          devServerUrl,
          mode: "dev",
          overrides,
          preview,
        });
        const nextSignature = routeSignature(next.manifest.routes);
        const structural = nextSignature !== lastSignature;
        // Generate first: the new runtime data (and any staged remote content)
        // is on disk and published before the store re-syncs against it.
        await generateRuntime(next);
        if (structural && !(await refreshBlumeContent())) {
          await server.stop();
          server = await createServer(boundPort, false);
        }
        // Commit the signature only after the (re)generation succeeded. If the
        // re-sync or restart above throws mid-sequence, the signature stays
        // stale so the next watch event retries the structural path.
        lastSignature = nextSignature;
        // Surface any content/config errors in the terminal AND the browser
        // overlay. The terminal report is not redundant: the overlay only
        // shows once the browser has connected, and it clears on the next HMR
        // update.
        reportDiagnostics(next.diagnostics, root);
        showBlumeErrorOverlay(next.diagnostics);
      } catch (error) {
        // A config error the generator raised (an unplannable `components.ts`
        // override, a missing font file) is a diagnostic: report it in the
        // terminal and the browser overlay like a scan-time error, so the fix
        // is visible where the edit happened.
        if (error instanceof BlumeError) {
          reportDiagnostics([error.diagnostic], root);
          showBlumeErrorOverlay([error.diagnostic]);
          return;
        }
        // SAFETY: regeneration failures come from the generator and Astro's
        // server API, which raise Error instances; only the message is shown.
        logger.error(`Regeneration failed: ${(error as Error).message}`);
      }
    }, 80);

    // The runtime prepared above baked the *requested* port into the site
    // fallback; if Vite bumped it, regenerate so OG images, canonicals, and
    // other site-gated URLs point at the port actually serving.
    if (boundPort !== port) {
      void regenerate();
    }

    // Content is watched per source (filesystem uses fs.watch; remote sources
    // are frozen for the session). The remaining project inputs — user pages,
    // config, theme, and component overrides — are watched directly.
    const dirTargets = [project.context.pagesRoot].filter(
      (target) => target !== null
    );
    const fileTargets = [
      project.context.configFile,
      project.context.themeFile,
      project.context.componentsFile,
    ].filter((target) => target !== null);

    // chokidar handles what raw fs.watch made us hand-roll: recursive
    // directory watching on every platform, and single files surviving a
    // rename-replace save (vim and most "atomic save" editors), which orphans
    // an inode-tracking fs.watch watcher after the first write.
    const projectWatcher = watch([...dirTargets, ...fileTargets], {
      ignoreInitial: true,
    }).on("all", regenerate);
    const disposers = [
      ...project.sources.map((source) => source.watch?.(regenerate)),
      () => {
        void projectWatcher.close();
      },
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

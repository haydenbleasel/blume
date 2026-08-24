import { readFile, utimes } from "node:fs/promises";

/**
 * Dev-server invalidation for `<include>` partials. A partial is not an Astro
 * content-collection entry (the default underscore-prefix exclude keeps it
 * out of the `docs` glob), so Vite has no edge from an including page to it —
 * editing the partial would keep serving the page's stale compiled module.
 * The scan records each page's transitive includes; `generateRuntime` writes
 * them to `generated/includes.json` as partial → including pages, and this
 * plugin turns a partial edit into an invalidation of those page modules plus
 * a full reload.
 *
 * The graph file is re-read on every hot update: `blume dev`'s regenerate
 * loop rewrites it after each content change, so the mapping tracks include
 * edits without restarting the server.
 */

/** The Vite module-graph slice the plugin touches (structurally typed, like
 * every Blume-authored Vite plugin — see `serverAppResolvePlugin`). */
interface IncludeHmrServer {
  moduleGraph: {
    getModulesByFile: (file: string) => Set<unknown> | undefined;
    invalidateModule: (mod: never) => void;
  };
  ws: { send: (payload: { type: "full-reload" }) => void };
}

export interface IncludeHmrContext {
  file: string;
  server: IncludeHmrServer;
}

export interface IncludeHmrPlugin {
  name: string;
  handleHotUpdate: (ctx: IncludeHmrContext) => Promise<never[] | undefined>;
}

export const includeHmrPlugin = (graphPath: string): IncludeHmrPlugin => ({
  async handleHotUpdate(ctx) {
    let graph: Record<string, string[]>;
    try {
      // SAFETY: `generateRuntime` is the file's only writer and serializes
      // exactly this shape; a malformed hand-edit throws into the catch below.
      graph = JSON.parse(await readFile(graphPath, "utf-8")) as Record<
        string,
        string[]
      >;
    } catch {
      // No graph yet (first run) — nothing to invalidate.
      return;
    }
    const includers = graph[ctx.file];
    if (!includers || includers.length === 0) {
      return;
    }
    const { moduleGraph, ws } = ctx.server;
    const now = new Date();
    for (const includer of includers) {
      for (const mod of moduleGraph.getModulesByFile(includer) ?? []) {
        // SAFETY: the module came out of this module graph; `never` only
        // reflects that the structural slice doesn't model the node type.
        moduleGraph.invalidateModule(mod as never);
      }
      // Plain `.md` pages have no Vite module: their HTML lives in the
      // content-layer store, rendered at sync time. Bump the page's mtime so
      // Astro's content watcher re-syncs it — the include-aware digest
      // (`withIncludeRefresh`) then forces a fresh render that re-reads the
      // edited partial.
      try {
        // oxlint-disable-next-line no-await-in-loop -- ordered per-page touch
        await utimes(includer, now, now);
      } catch {
        // The page may have been deleted since the graph was written.
      }
    }
    ws.send({ type: "full-reload" });
    // The partial itself is not a module; suppress Vite's default handling.
    return [];
  },
  name: "blume:include-hmr",
});

import { readFile } from "node:fs/promises";

import { resolve } from "pathe";

import { refreshBlumeContent } from "./integration.ts";

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
 * every Blume-authored Vite plugin — see `serverAppResolvePlugin`). Every
 * environment keeps its own graph, and the server's own `moduleGraph` only
 * covers `client` and `ssr`: with `@astrojs/cloudflare` the content pages
 * render in the `prerender` environment instead. */
interface IncludeHmrServer {
  config: { root: string };
  environments: Record<
    string,
    {
      moduleGraph: {
        getModulesByFile: (file: string) => Set<unknown> | undefined;
        invalidateModule: (mod: never) => void;
      };
    }
  >;
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
    // An ejected app's graph is relative to the project, its Vite root; the
    // hidden runtime's is absolute, which resolving leaves as it is.
    const { config, environments, ws } = ctx.server;
    const includers = Object.entries(graph).find(
      ([partial]) => resolve(config.root, partial) === ctx.file
    )?.[1];
    if (!includers || includers.length === 0) {
      return;
    }
    for (const { moduleGraph } of Object.values(environments)) {
      for (const includer of includers) {
        for (const mod of moduleGraph.getModulesByFile(
          resolve(config.root, includer)
        ) ?? []) {
          // SAFETY: the module came out of this module graph; `never` only
          // reflects that the structural slice doesn't model the node type.
          moduleGraph.invalidateModule(mod as never);
        }
      }
    }
    // Plain `.md` pages have no Vite module: their HTML lives in the
    // content-layer store, rendered at sync time. Ask Astro to re-run the
    // loaders — `withIncludeRefresh` then evicts the includers whose partials
    // changed, so the glob loader renders them afresh. `false` only before
    // the server's `astro:server:setup` has run, when there is no store to go
    // stale yet.
    await refreshBlumeContent();
    ws.send({ type: "full-reload" });
    // The partial itself is not a module; suppress Vite's default handling.
    return [];
  },
  name: "blume:include-hmr",
});

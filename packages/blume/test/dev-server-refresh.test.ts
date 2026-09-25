import { afterEach, describe, expect, it } from "bun:test";

import {
  blumeIntegration,
  refreshBlumeContent,
} from "../src/astro/integration.ts";

/** Astro's content-layer data store, as each Vite environment resolves it. */
const DATA_STORE = "\0astro:data-layer-content";

/**
 * Run the integration's `astro:server:setup` against a dev server double
 * whose environments have loaded the given module ids, recording every
 * invalidation (as `environment:id`), reload, and content re-sync in order.
 */
const setupServer = (graphs: Record<string, string[]>): string[] => {
  const events: string[] = [];
  const environments: Record<
    string,
    {
      moduleGraph: {
        getModuleById: (id: string) => { id: string } | undefined;
        invalidateModule: (mod: { id: string }) => void;
      };
    }
  > = {};
  for (const [name, ids] of Object.entries(graphs)) {
    environments[name] = {
      moduleGraph: {
        getModuleById: (id) => (ids.includes(id) ? { id } : undefined),
        invalidateModule: (mod) => {
          events.push(`${name}:${mod.id}`);
        },
      },
    };
  }
  // SAFETY: the hook only touches the middleware stack, the environments'
  // module graphs, the ws channel, and `refreshContent`, all provided here.
  blumeIntegration({ pages: [] }).hooks["astro:server:setup"]?.({
    refreshContent: () => {
      events.push("refresh");
      return Promise.resolve();
    },
    server: {
      environments,
      middlewares: { stack: [] },
      ws: {
        send: (payload: { type: string }) => {
          events.push(payload.type);
        },
      },
    },
  } as never);
  return events;
};

// The registry lives on globalThis; leave no refresh (or server) behind.
afterEach(() => {
  // SAFETY: as above, with no refresh registered.
  blumeIntegration({ pages: [] }).hooks["astro:server:setup"]?.({
    server: { environments: {}, middlewares: { stack: [] } },
  } as never);
});

describe("refreshBlumeContent", () => {
  it("invalidates Astro's data store in every environment after the re-sync", async () => {
    // Astro invalidates its data store after a sync in the `ssr` environment
    // only. With @astrojs/cloudflare the content pages render in `prerender`
    // (`ssr` runs in workerd), whose copy stayed at its startup snapshot: a
    // page added in dev matched its route but `getEntry` missed it, so it
    // 404ed until a restart.
    const events = setupServer({
      astro: [],
      client: [],
      prerender: [DATA_STORE],
      ssr: [DATA_STORE],
    });

    expect(await refreshBlumeContent()).toBe(true);

    // Invalidated only once the store is re-synced, then one reload so no
    // page renders the copy that was stale when Astro reloaded the browser.
    expect(events).toEqual([
      "refresh",
      `prerender:${DATA_STORE}`,
      `ssr:${DATA_STORE}`,
      "full-reload",
    ]);
  });
});

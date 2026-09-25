import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { join } from "pathe";

import { blumeIntegration } from "../src/astro/integration.ts";

/** Astro's content-layer data store, as each Vite environment resolves it. */
const DATA_STORE = "\0astro:data-layer-content";

/** An Astro root that is never read: the hooks only derive paths from it. */
const ROOT = pathToFileURL(join(tmpdir(), "blume-data-store-watch", "/"));

/** Where Astro writes the dev content store under {@link ROOT}. */
const STORE_FILE = fileURLToPath(new URL(".astro/data-store.json", ROOT));

type Listener = (path: string) => void;

/**
 * Run `astro:config:done` then `astro:server:setup` against a dev server
 * double whose `prerender` and `ssr` environments have loaded the data store,
 * recording every invalidation (as `environment:id`) and reload in order.
 * Returns the recorded events and a way to fire a watcher event.
 */
const setup = () => {
  const events: string[] = [];
  const listeners: { event: string; listener: Listener }[] = [];
  const graph = (name: string) => ({
    moduleGraph: {
      getModuleById: (id: string) => (id === DATA_STORE ? { id } : undefined),
      invalidateModule: (mod: { id: string }) => {
        events.push(`${name}:${mod.id}`);
      },
    },
  });
  const integration = blumeIntegration({ pages: [] });
  // SAFETY: the hook reads only `config.root`/`config.srcDir` and calls
  // `injectTypes`, all provided here.
  integration.hooks["astro:config:done"]?.({
    config: { root: ROOT, srcDir: new URL("src/", ROOT) },
    injectTypes: () => new URL("modules.d.ts", ROOT),
  } as never);
  // SAFETY: the hook touches only the middleware stack, the environments'
  // module graphs, the ws channel, and the watcher, all provided here.
  integration.hooks["astro:server:setup"]?.({
    server: {
      environments: { prerender: graph("prerender"), ssr: graph("ssr") },
      middlewares: { stack: [] },
      watcher: {
        on: (event: string, listener: Listener) => {
          listeners.push({ event, listener });
        },
      },
      ws: {
        send: (payload: { type: string }) => {
          events.push(payload.type);
        },
      },
    },
  } as never);
  return {
    emit: (event: "add" | "change", path: string) => {
      for (const entry of listeners) {
        if (entry.event === event) {
          entry.listener(path);
        }
      }
    },
    events,
  };
};

// The registry lives on globalThis; leave no server behind.
afterEach(() => {
  // SAFETY: a bare server with no environments or watcher.
  blumeIntegration({ pages: [] }).hooks["astro:server:setup"]?.({
    server: { environments: {}, middlewares: { stack: [] } },
  } as never);
});

describe("dev data store watch", () => {
  it("invalidates the store in every environment when Astro rewrites it", () => {
    // A body edit to a `.md` page updates the store, which Astro invalidates
    // in `ssr` only; with @astrojs/cloudflare the page renders in `prerender`.
    const { emit, events } = setup();

    emit("change", STORE_FILE);
    expect(events).toEqual([
      `prerender:${DATA_STORE}`,
      `ssr:${DATA_STORE}`,
      "full-reload",
    ]);

    // A store created on first write counts too.
    events.length = 0;
    emit("add", STORE_FILE);
    expect(events).toEqual([
      `prerender:${DATA_STORE}`,
      `ssr:${DATA_STORE}`,
      "full-reload",
    ]);
  });

  it("ignores every other file the watcher reports", () => {
    const { emit, events } = setup();
    emit("change", fileURLToPath(new URL(".astro/settings.json", ROOT)));
    emit("add", fileURLToPath(new URL("src/pages/index.astro", ROOT)));
    expect(events).toEqual([]);
  });
});

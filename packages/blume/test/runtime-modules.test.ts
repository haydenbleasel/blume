import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  publishRuntimeModules,
  readRuntimeModule,
  RUNTIME_MODULE_FILES,
  runtimeModulesPlugin,
} from "../src/astro/runtime-modules.ts";
import type {
  RuntimeModuleId,
  RuntimeModuleServer,
} from "../src/astro/runtime-modules.ts";

/**
 * A minimal dev server double recording what the registry does to it. `known`
 * seeds the `ssr` environment's graph; `environments` names what every other
 * environment has loaded, for the tests that span several.
 */
const fakeServer = (
  options: {
    environments?: Record<string, string[]>;
    known?: string[];
    httpServer?: boolean;
  } = {}
) => {
  const invalidated: string[] = [];
  const invalidatedIn: Record<string, string[]> = {};
  const sent: string[] = [];
  let onClose: (() => void) | undefined;
  const graphs = { ssr: options.known ?? [], ...options.environments };
  const environments: RuntimeModuleServer["environments"] = {};
  for (const [name, ids] of Object.entries(graphs)) {
    const known = new Set(ids);
    const log: string[] = [];
    invalidatedIn[name] = log;
    environments[name] = {
      moduleGraph: {
        getModuleById: (id) => (known.has(id) ? { id } : undefined),
        invalidateModule: (mod) => {
          invalidated.push(mod.id ?? "");
          log.push(mod.id ?? "");
        },
      },
    };
  }
  const server: RuntimeModuleServer = {
    environments,
    httpServer:
      options.httpServer === false
        ? null
        : {
            once: (_event, listener) => {
              onClose = listener;
            },
          },
    ws: {
      send: (payload) => {
        sent.push(payload.type);
      },
    },
  };
  return {
    close: () => onClose?.(),
    invalidated,
    invalidatedIn,
    sent,
    server,
  };
};

const modules = (
  entries: [RuntimeModuleId, string][]
): Map<RuntimeModuleId, string> => new Map(entries);

// The registry is process-global: start from empty regardless of what other
// test files published, and leave it empty for the ones that follow.
beforeEach(() => {
  publishRuntimeModules(new Map());
});
afterEach(() => {
  publishRuntimeModules(new Map());
});

describe("publishRuntimeModules", () => {
  it("stores every published module and reports what changed", () => {
    const changed = publishRuntimeModules(
      modules([
        ["blume:data", '{"a":1}'],
        ["blume:openapi", "{}"],
      ])
    );
    expect(changed.toSorted()).toEqual(["blume:data", "blume:openapi"]);
    expect(readRuntimeModule("blume:data")).toBe('{"a":1}');
    expect(readRuntimeModule("blume:openapi")).toBe("{}");
    expect(readRuntimeModule("blume:rss")).toBeUndefined();
  });

  it("is quiet when nothing changed", () => {
    publishRuntimeModules(modules([["blume:data", "{}"]]));
    const { server, invalidated, sent } = fakeServer({
      known: ["\0blume:data"],
    });
    runtimeModulesPlugin().configureServer(server);

    expect(publishRuntimeModules(modules([["blume:data", "{}"]]))).toEqual([]);
    expect(invalidated).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("unpublishes an id absent from the next set", () => {
    publishRuntimeModules(
      modules([
        ["blume:data", "{}"],
        ["blume:rss", "{}"],
      ])
    );
    expect(publishRuntimeModules(modules([["blume:data", "{}"]]))).toEqual([
      "blume:rss",
    ]);
    expect(readRuntimeModule("blume:rss")).toBeUndefined();
  });

  it("invalidates the changed modules in every live server and reloads once", () => {
    publishRuntimeModules(
      modules([
        ["blume:data", "1"],
        ["blume:openapi", "1"],
        ["blume:rss", "1"],
      ])
    );
    // One server has loaded all three, one only the page data, and one is
    // still warming up with nothing in its graph.
    const full = fakeServer({
      known: ["\0blume:data", "\0blume:openapi", "\0blume:rss"],
    });
    const partial = fakeServer({ known: ["\0blume:data"] });
    const cold = fakeServer();
    const plugin = runtimeModulesPlugin();
    for (const { server } of [full, partial, cold]) {
      plugin.configureServer(server);
    }

    const changed = publishRuntimeModules(
      modules([
        ["blume:data", "2"],
        ["blume:openapi", "1"],
      ])
    );

    expect(changed.toSorted()).toEqual(["blume:data", "blume:rss"]);
    expect(full.invalidated.toSorted()).toEqual([
      "\0blume:data",
      "\0blume:rss",
    ]);
    expect(partial.invalidated).toEqual(["\0blume:data"]);
    expect(cold.invalidated).toEqual([]);
    for (const { sent } of [full, partial, cold]) {
      expect(sent).toEqual(["full-reload"]);
    }
  });

  it("invalidates the changed modules in every environment's graph", () => {
    // Each Vite environment keeps its own module graph. With
    // @astrojs/cloudflare the content pages render in `prerender` (the `ssr`
    // environment runs in workerd), so invalidating only the graphs Vite's
    // legacy `server.moduleGraph` covers (`client` and `ssr`) left every page
    // on its startup data: a new page 404ed and a sidebar label never moved.
    publishRuntimeModules(
      modules([
        ["blume:data", "1"],
        ["blume:raw-markdown", "1"],
      ])
    );
    const cloudflare = fakeServer({
      environments: {
        astro: [],
        client: [],
        prerender: ["\0blume:data", "\0blume:raw-markdown"],
      },
      known: ["\0blume:data"],
    });
    runtimeModulesPlugin().configureServer(cloudflare.server);

    publishRuntimeModules(
      modules([
        ["blume:data", "2"],
        ["blume:raw-markdown", "2"],
      ])
    );

    expect(cloudflare.invalidatedIn).toEqual({
      astro: [],
      client: [],
      prerender: ["\0blume:data", "\0blume:raw-markdown"],
      ssr: ["\0blume:data"],
    });
    // Still one reload for the whole publication, not one per environment.
    expect(cloudflare.sent).toEqual(["full-reload"]);
  });

  it("stops touching a server once it closes", () => {
    publishRuntimeModules(modules([["blume:data", "1"]]));
    const closed = fakeServer({ known: ["\0blume:data"] });
    const live = fakeServer({ known: ["\0blume:data"] });
    const plugin = runtimeModulesPlugin();
    plugin.configureServer(closed.server);
    plugin.configureServer(live.server);
    closed.close();

    publishRuntimeModules(modules([["blume:data", "2"]]));

    expect(closed.sent).toEqual([]);
    expect(live.sent).toEqual(["full-reload"]);
  });

  it("registers a server that exposes no http server", () => {
    // Middleware mode leaves `httpServer` null; the registration must still
    // succeed (the handle is simply never dropped).
    publishRuntimeModules(modules([["blume:data", "1"]]));
    const headless = fakeServer({ httpServer: false, known: ["\0blume:data"] });
    runtimeModulesPlugin().configureServer(headless.server);

    publishRuntimeModules(modules([["blume:data", "2"]]));

    expect(headless.invalidated).toEqual(["\0blume:data"]);
  });
});

describe("runtimeModulesPlugin", () => {
  const plugin = runtimeModulesPlugin();

  it("claims every runtime module id ahead of Vite's resolver", () => {
    expect(plugin.enforce).toBe("pre");
    for (const id of RUNTIME_MODULE_FILES.keys()) {
      expect(plugin.resolveId(id)).toBe(`\0${id}`);
    }
    expect(plugin.resolveId("blume:theme")).toBeUndefined();
    expect(plugin.resolveId("react")).toBeUndefined();
  });

  it("serves a published module as a parsed default export", () => {
    publishRuntimeModules(modules([["blume:data", '{"routes":["/"]}']]));
    const code = plugin.load("\0blume:data");
    expect(code).toBe(
      'export default JSON.parse("{\\"routes\\":[\\"/\\"]}");\n'
    );
  });

  it("leaves ids it does not own to other plugins", () => {
    expect(plugin.load("/src/pages/index.astro")).toBeUndefined();
    expect(plugin.load("\0astro:something")).toBeUndefined();
  });

  it("fails loudly when a module is requested before it was published", () => {
    expect(() => plugin.load("\0blume:rss")).toThrow(
      /blume:rss.*before it was published/u
    );
  });
});

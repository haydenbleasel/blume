/**
 * In-memory runtime data modules.
 *
 * The generated runtime's data snapshots — the page data behind `blume:data`,
 * the parsed API specs, the static search index, the raw-Markdown and
 * content-asset maps, the MCP and Ask corpora, and the rendered RSS feeds —
 * used to be written under `.blume/src/generated/*.json` and imported by the
 * generated pages through aliases or relative paths. `generateRuntime` now
 * publishes them here and `runtimeModulesPlugin` serves them to Vite as
 * virtual modules, so a regeneration never round-trips the disk or waits on a
 * file watcher: publishing invalidates the changed modules in every live dev
 * server (Vite walks the importers, so the pages that render them re-evaluate
 * on the next request) and asks the browser to reload — the same effect a JSON
 * file change used to reach through the watcher, minus the write and the
 * watch debounce.
 *
 * The registry hangs off `globalThis`, not module state. On a published
 * install the CLI bundle (`dist/cli`) carries its own copy of this module,
 * separate from the one Vite loads from `blume/astro` for the generated
 * config, and both must see the same map. `blume dev`, `blume build`, and
 * `blume check` all run Astro in-process, so the map the CLI fills is the map
 * the plugin reads.
 *
 * `blume eject` keeps the file form: the ejected project has no CLI to
 * publish, so its `astro.config.mjs` aliases each id to the JSON file eject
 * writes under `src/generated/` — the names in {@link RUNTIME_MODULE_FILES}.
 */

export type RuntimeModuleId =
  | "blume:ask-data"
  | "blume:content-assets"
  | "blume:data"
  | "blume:mcp-data"
  | "blume:openapi"
  | "blume:raw-markdown"
  | "blume:rss"
  | "blume:search-index";

/** Virtual module id → the `src/generated` JSON file eject writes for it. */
export const RUNTIME_MODULE_FILES: ReadonlyMap<RuntimeModuleId, string> =
  new Map([
    ["blume:ask-data", "ask-data.json"],
    ["blume:content-assets", "content-assets.json"],
    ["blume:data", "data.json"],
    ["blume:mcp-data", "mcp-data.json"],
    ["blume:openapi", "openapi.json"],
    ["blume:raw-markdown", "raw-markdown.json"],
    ["blume:rss", "rss.json"],
    ["blume:search-index", "search.json"],
  ]);

const RUNTIME_MODULE_IDS: ReadonlySet<string> = new Set(
  RUNTIME_MODULE_FILES.keys()
);

/** Rollup's virtual-module convention: `\0` keeps other plugins off the id. */
const RESOLVED_PREFIX = "\0";

/** A node in Vite's module graph; only its identity matters here. */
interface RuntimeModuleNode {
  id: string | null;
}

/**
 * The Vite dev-server slice the registry touches (structurally typed, like
 * every Blume-authored Vite plugin — see `includeHmrPlugin`).
 */
export interface RuntimeModuleServer {
  httpServer?: {
    once: (event: "close", listener: () => void) => void;
  } | null;
  moduleGraph: {
    getModuleById: (id: string) => RuntimeModuleNode | undefined;
    invalidateModule: (mod: RuntimeModuleNode) => void;
  };
  ws: { send: (payload: { type: "full-reload" }) => void };
}

interface RuntimeModuleRegistry {
  /** Published JSON text by module id. */
  modules: Map<string, string>;
  /** Live dev servers to invalidate on publish. */
  servers: Set<RuntimeModuleServer>;
}

const REGISTRY_KEY = Symbol.for("blume.runtime-modules");

type RegistryHost = typeof globalThis & {
  [REGISTRY_KEY]?: RuntimeModuleRegistry;
};

const registry = (): RuntimeModuleRegistry => {
  // SAFETY: the registry is stashed on globalThis under a well-known symbol so
  // every copy of this module in the process shares it; the intersection only
  // names that slot.
  const host = globalThis as RegistryHost;
  host[REGISTRY_KEY] ??= { modules: new Map(), servers: new Set() };
  return host[REGISTRY_KEY];
};

/** The published JSON text for a module, if any (tests and diagnostics). */
export const readRuntimeModule = (id: RuntimeModuleId): string | undefined =>
  registry().modules.get(id);

/**
 * Replace the published snapshot set with `modules` (an id absent from the map
 * is unpublished — its feature was switched off). Returns the ids whose text
 * changed; each is invalidated in every live dev server, followed by one
 * full-reload per server. Nothing is sent when nothing changed, so a
 * regeneration triggered by an unrelated edit stays quiet — the same contract
 * `writeIfChanged` gave the file form.
 */
export const publishRuntimeModules = (
  modules: ReadonlyMap<RuntimeModuleId, string>
): RuntimeModuleId[] => {
  const { modules: current, servers } = registry();
  const changed: RuntimeModuleId[] = [];
  for (const id of RUNTIME_MODULE_FILES.keys()) {
    const next = modules.get(id);
    if (current.get(id) === next) {
      continue;
    }
    if (next === undefined) {
      current.delete(id);
    } else {
      current.set(id, next);
    }
    changed.push(id);
  }
  if (changed.length === 0) {
    return changed;
  }
  for (const server of servers) {
    for (const id of changed) {
      const mod = server.moduleGraph.getModuleById(`${RESOLVED_PREFIX}${id}`);
      if (mod) {
        server.moduleGraph.invalidateModule(mod);
      }
    }
    server.ws.send({ type: "full-reload" });
  }
  return changed;
};

export interface RuntimeModulesPlugin {
  configureServer: (server: RuntimeModuleServer) => void;
  enforce: "pre";
  load: (id: string) => string | undefined;
  name: string;
  resolveId: (id: string) => string | undefined;
}

/**
 * Serve the published runtime modules to Vite. `enforce: "pre"` claims the
 * `blume:*` ids before Vite's resolver would try (and fail) to find them as
 * packages. Loading an unpublished id is a hard error rather than an empty
 * module: the generated pages only import a module when its data exists, so a
 * miss means the config was run outside the CLI that publishes.
 */
export const runtimeModulesPlugin = (): RuntimeModulesPlugin => ({
  configureServer(server) {
    const { servers } = registry();
    servers.add(server);
    // Astro restarts the dev container in place on a config change (and the
    // CLI restarts it on a route-set change): the old Vite server closes and
    // a new one registers, so drop the stale handle rather than invalidating
    // into a dead graph.
    server.httpServer?.once("close", () => {
      servers.delete(server);
    });
  },
  enforce: "pre",
  load(id) {
    if (!id.startsWith(RESOLVED_PREFIX)) {
      return;
    }
    const moduleId = id.slice(RESOLVED_PREFIX.length);
    if (!RUNTIME_MODULE_IDS.has(moduleId)) {
      return;
    }
    const text = registry().modules.get(moduleId);
    if (text === undefined) {
      throw new Error(
        `Blume runtime module "${moduleId}" was requested before it was published. Run the generated project through the Blume CLI (blume dev / blume build), which publishes the runtime data before starting Astro.`
      );
    }
    // A JSON.parse over a string literal evaluates faster than an equivalent
    // object literal for large snapshots (V8's guidance; Vite's own JSON
    // plugin does the same past a size threshold).
    return `export default JSON.parse(${JSON.stringify(text)});\n`;
  },
  name: "blume:runtime-modules",
  resolveId(id) {
    return RUNTIME_MODULE_IDS.has(id) ? `${RESOLVED_PREFIX}${id}` : undefined;
  },
});

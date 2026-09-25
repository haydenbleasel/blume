import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import type { AstroIntegration } from "astro";
import { join, relative, resolve } from "pathe";

import { loadEnvFiles } from "../cli/env.ts";
import type { CustomPageRoute } from "../core/custom-pages.ts";
import { enrichDiagnostic } from "../core/diagnostics.ts";
import { scanProject } from "../core/project-graph.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { Diagnostic } from "../core/types.ts";
import { publishBuildArtifacts } from "../deploy/artifacts.ts";
import type { ArtifactLogger } from "../deploy/artifacts.ts";
import { markdownVariantUrl, prefersMarkdown } from "./markdown-negotiation.ts";
import { runtimeModuleDeclarations } from "./module-types.ts";

/** The `{ type: "error" }` payload Vite's browser overlay renders. */
interface OverlayErrorPayload {
  err: {
    id?: string;
    message: string;
    plugin: string;
    stack: string;
  };
  type: "error";
}

/** The dev server's HMR channel — either `.ws` (Vite ≤5) or `.hot` (Vite 6+). */
interface OverlayChannel {
  send: (payload: OverlayErrorPayload | { type: "full-reload" }) => void;
}

/** A node in a Vite environment's module graph; only its identity matters. */
interface DevModuleNode {
  id: string | null;
}

/**
 * The dev-server slice the integration keeps: the overlay channel, and every
 * Vite environment's module graph for the content re-sync (structurally
 * typed, like every Blume-authored Vite plugin).
 */
interface DevServer {
  environments: Record<
    string,
    {
      moduleGraph: {
        getModuleById: (id: string) => DevModuleNode | undefined;
        invalidateModule: (mod: never) => void;
      };
    }
  >;
  hot?: OverlayChannel;
  ws?: OverlayChannel;
}

/** The dev server's file watcher, as far as the data-store watch uses it. */
interface WatchedServer {
  watcher: {
    on: (event: "add" | "change", listener: (path: string) => void) => void;
  };
}

/** The parameters Astro hands `astro:server:setup`. */
type ServerSetupParams = Parameters<
  NonNullable<AstroIntegration["hooks"]["astro:server:setup"]>
>[0];

/**
 * Astro's `refreshContent`: re-runs every content-layer loader against the
 * live store, the sanctioned way to re-sync content that changed outside
 * Astro's own file watcher.
 */
type RefreshContent = NonNullable<ServerSetupParams["refreshContent"]>;

/** What the dev negotiation middleware needs per request. */
interface DevNegotiation {
  /** Page routes that have a raw-Markdown variant (the content manifest). */
  contentRoutes: ReadonlySet<string>;
  /** Homepage agent-discovery `Link` header, when the site has one. */
  homeLinkHeader?: string;
}

/**
 * The state shared between the CLI and the integration: the live dev server
 * (for the browser error overlay), Astro's `refreshContent` (so the CLI's
 * regeneration can re-sync the content store instead of restarting the
 * server), the negotiation inputs the CLI publishes on every regeneration (so
 * a content-route change never rewrites the generated config, which would
 * restart the server in place), and the scanned project a `blume build`
 * hands over so `astro:build:done` can write the deploy artifacts.
 *
 * Kept on `globalThis` rather than in module state, for the same reason as
 * the runtime-module registry (see `runtime-modules.ts`): on a published
 * install the CLI bundle (`dist/cli`) carries its own copy of this module,
 * while the hooks run in the copy Vite loads from `blume/astro` for the
 * generated config. A module-level variable is set in one copy and read in
 * the other, so the overlay never showed anything outside this repository.
 */
interface DevServerRegistry {
  buildProject: BlumeProject | null;
  negotiation: DevNegotiation | null;
  overlay: DevServer | null;
  refreshContent: RefreshContent | null;
}

const REGISTRY_KEY = Symbol.for("blume.integration");

type RegistryHost = typeof globalThis & {
  [REGISTRY_KEY]?: DevServerRegistry;
};

const registry = (): DevServerRegistry => {
  // SAFETY: the registry is stashed on globalThis under a well-known symbol so
  // every copy of this module in the process shares it; the intersection only
  // names that slot.
  const host = globalThis as RegistryHost;
  host[REGISTRY_KEY] ??= {
    buildProject: null,
    negotiation: null,
    overlay: null,
    refreshContent: null,
  };
  return host[REGISTRY_KEY];
};

/**
 * Hand the scanned project to the integration ahead of `build()`, so its
 * `astro:build:done` hook can write the deploy artifacts without scanning
 * again. `blume build` publishes it for a real build and nothing for an
 * isolated verify build, which produces no artifacts. `null` withdraws it.
 */
export const publishBuildProject = (project: BlumeProject | null): void => {
  registry().buildProject = project;
};

/**
 * The project an `astro build` with no CLI in front of it (an ejected app)
 * writes artifacts for: scanned from `buildArtifactsRoot`, resolved against
 * the Astro root recorded on `astro:config:done`. Scan diagnostics surface as
 * warnings — there is no `--strict` to honor here, and the build itself has
 * already succeeded. `null` when nothing asked for a scan.
 */
const scanForArtifacts = async (
  astroRoot: URL | null,
  artifactsRoot: string | undefined,
  logger: ArtifactLogger
): Promise<BlumeProject | null> => {
  if (!(astroRoot && artifactsRoot)) {
    return null;
  }
  const root = resolve(fileURLToPath(astroRoot), artifactsRoot);
  // Remote sources read their tokens from the environment during the scan.
  loadEnvFiles(root);
  const project = await scanProject(root, { mode: "build" });
  for (const diagnostic of project.diagnostics) {
    logger.warn(`[${diagnostic.code}] ${diagnostic.message}`);
  }
  return project;
};

/**
 * Publish the dev negotiation inputs for the running server: the content
 * routes with a Markdown variant and the homepage `Link` header. Called by
 * `generateRuntime` on every pass, so the middleware follows a route rename
 * without the generated config changing. `null` withdraws a publication, so
 * the middleware falls back to the options baked into the integration call
 * (an ejected project has no CLI to publish).
 */
export const publishDevNegotiation = (
  negotiation: {
    contentRoutes: readonly string[];
    homeLinkHeader?: string;
  } | null
): void => {
  registry().negotiation = negotiation
    ? {
        contentRoutes: new Set(negotiation.contentRoutes),
        homeLinkHeader: negotiation.homeLinkHeader,
      }
    : null;
};

/** A dev server's HMR channel: `.ws`, or `.hot` where only that exists. */
const overlayChannelOf = (
  server: DevServer | null
): OverlayChannel | undefined => server?.ws ?? server?.hot;

/** Astro's content-layer data store, a virtual module in each environment. */
const DATA_STORE_MODULE_ID = "\0astro:data-layer-content";

/**
 * Invalidate Astro's data store in every Vite environment, then reload the
 * browser. Astro invalidates it after a sync in the `ssr` environment only,
 * which is where pages render on most adapters. With `@astrojs/cloudflare`
 * the `ssr` environment runs in workerd and the prerendered pages (every
 * content page) render in the `prerender` environment, whose copy of the
 * store then stayed at its startup snapshot: a page added in dev resolved
 * its route but `getEntry` still missed it, so it 404ed until a restart.
 */
const invalidateDataStore = (server: DevServer): void => {
  for (const { moduleGraph } of Object.values(server.environments)) {
    const mod = moduleGraph.getModuleById(DATA_STORE_MODULE_ID);
    if (mod) {
      // SAFETY: the node came out of this same module graph; `never` only
      // reflects that the structural slice doesn't model the node type.
      moduleGraph.invalidateModule(mod as never);
    }
  }
  // Astro reloaded the browser when the store was written, which can land
  // before the invalidation above; reload again so no page renders the
  // stale copy.
  overlayChannelOf(server)?.send({ type: "full-reload" });
};

/**
 * Where Astro keeps the dev content store: `data-store.json` in the root's
 * `.astro/` directory. Astro reloads its virtual module from this file.
 */
const devDataStoreFile = (root: URL): string =>
  fileURLToPath(new URL(".astro/data-store.json", root));

/**
 * Invalidate the data store in every environment whenever Astro rewrites it.
 * Astro's own file watcher updates the store on a content edit — a `.md`
 * page's rendered body lives in it — but invalidates the module in `ssr`
 * only, so with `@astrojs/cloudflare` a body edit stayed stale in
 * `prerender` until something structural re-synced it. Keyed on the store
 * write rather than Blume's regeneration, which can finish first.
 */
const watchDataStore = (server: DevServer & WatchedServer, root: URL): void => {
  const file = devDataStoreFile(root);
  const onWrite = (path: string): void => {
    if (path === file) {
      invalidateDataStore(server);
    }
  };
  server.watcher.on("add", onWrite);
  server.watcher.on("change", onWrite);
};

/**
 * Re-run Astro's content-layer loaders against the live dev server. Returns
 * `false` when no server has registered one — before the first
 * `astro:server:setup`, or outside `blume dev` — so the caller can fall back.
 * A route-set change (a page added, removed, or a folder renamed) is what
 * needs this: Astro's glob watcher misses directory renames, and its in-place
 * config restart never re-globs, so without a re-sync `getEntry` reads a
 * stale store and the moved page 404s.
 */
export const refreshBlumeContent = async (): Promise<boolean> => {
  const { overlay, refreshContent } = registry();
  if (!refreshContent) {
    return false;
  }
  // No loader filter: every collection re-syncs (the docs glob and any
  // staged collection alike).
  await refreshContent({});
  if (overlay) {
    invalidateDataStore(overlay);
  }
  return true;
};

const overlayChannel = (): OverlayChannel | undefined =>
  overlayChannelOf(registry().overlay);

/**
 * Surface Blume's own diagnostics (config/frontmatter/content errors) in the
 * Vite/Astro browser error overlay during `blume dev`, so they don't hide in the
 * terminal. A no-op when there are no errors or the dev server isn't up. The
 * overlay clears itself on the next successful HMR update.
 */
export const showBlumeErrorOverlay = (diagnostics: Diagnostic[]): void => {
  const errors: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") {
      errors.push(enrichDiagnostic(diagnostic));
    }
  }
  const channel = overlayChannel();
  if (errors.length === 0 || !channel) {
    return;
  }
  const body = errors
    .map((diagnostic) => {
      const lineSuffix = diagnostic.line ? `:${diagnostic.line}` : "";
      const where = diagnostic.file
        ? `\n  at ${diagnostic.file}${lineSuffix}`
        : "";
      const fix = diagnostic.suggestion
        ? `\n  fix: ${diagnostic.suggestion}`
        : "";
      const docs = diagnostic.docsUrl ? `\n  docs: ${diagnostic.docsUrl}` : "";
      return `[${diagnostic.code}] ${diagnostic.message}${where}${fix}${docs}`;
    })
    .join("\n\n");
  channel.send({
    err: {
      id: errors[0]?.file,
      message: `Blume found ${errors.length} error(s):\n\n${body}`,
      plugin: "blume",
      stack: "",
    },
    type: "error",
  });
};

/** A user page mounted into the generated runtime. */
export type BlumePageRoute = CustomPageRoute;

export interface BlumeIntegrationOptions {
  pages: BlumePageRoute[];
  /**
   * Page routes that have a raw-Markdown variant (the content manifest). The
   * hidden runtime leaves this out: the CLI publishes the live set through
   * `publishDevNegotiation` on every regeneration, so a route change never
   * rewrites the generated config. An ejected project, which has no CLI,
   * bakes it in here.
   */
  contentRoutes?: string[];
  /**
   * Homepage `Link` header value for agent discovery (see
   * `ai/link-headers.ts`); the dev-server counterpart of the `_headers` /
   * Vercel-config emission, so `curl -I` against `blume dev` shows it too —
   * built for the `"dev"` surface, which leaves out the targets only a build
   * writes. Published the same way as `contentRoutes`.
   */
  homeLinkHeader?: string;
  /**
   * Blume project root to scan on `astro:build:done` for the deploy artifacts
   * (search index, llms.txt, sitemap, …) when no CLI has published the
   * project — an ejected app running plain `astro build`. Relative to the
   * Astro root. The hidden runtime leaves it unset: `blume build` publishes
   * its already-scanned project instead.
   */
  buildArtifactsRoot?: string;
}

/**
 * Whether a dev-server request URL is the homepage: the path (query dropped,
 * trailing slash tolerated) is the root.
 */
const isHomeUrl = (rawUrl: string | undefined): boolean => {
  if (!rawUrl) {
    return false;
  }
  const queryIndex = rawUrl.indexOf("?");
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  return path === "" || path === "/";
};

/**
 * Dev-server content negotiation: when a client asks for `text/markdown`,
 * transparently rewrite a content-page request to its `.md` variant so the
 * existing raw-Markdown endpoint serves it. Runs only under `blume dev` — in
 * production the content pages are prerendered and served from the platform's
 * static layer, which this middleware never fronts. Vercel server builds get
 * the same negotiation from routing rules spliced into the Build Output config
 * (see `deploy/vercel-negotiation.ts`), Cloudflare server builds from a
 * wrapper Worker routed to by `assets.run_worker_first` (see
 * `deploy/cloudflare-negotiation.ts`); every other build exposes the same
 * content at the `.md` URL. Only routes with a Markdown variant are rewritten,
 * so user `.astro` pages keep serving HTML — except the homepage, whose
 * variant falls back to the synthesized llms.txt mirror when it's a landing
 * page (see `markdownRoutePaths`). The same
 * middleware also stamps the homepage agent-discovery `Link` header, mirroring
 * what the deployed site sends via `_headers` / the Vercel routing config
 * minus the targets the dev server doesn't serve.
 *
 * Request URLs arrive base-less: Astro unshifts its own dev middlewares (base,
 * trailing slash, route guard) ahead of this one from its post-`configureServer`
 * hook, and its base middleware has already rewritten `/<base>/guide` to
 * `/guide`. Stripping `deployment.base` here a second time would leave no
 * request matching a content route.
 */
const negotiateMarkdown =
  (fallback: DevNegotiation) =>
  (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    // Read per request: the CLI republishes on every regeneration, so a page
    // renamed while the server runs negotiates under its new route.
    const { contentRoutes, homeLinkHeader } =
      registry().negotiation ?? fallback;
    if (req.method === "GET" || req.method === "HEAD") {
      if (homeLinkHeader && isHomeUrl(req.url)) {
        res.setHeader("Link", homeLinkHeader);
      }
      if (prefersMarkdown(req.headers.accept)) {
        const variant = markdownVariantUrl(req.url, contentRoutes);
        if (variant) {
          res.setHeader("Vary", "Accept");
          req.url = variant;
        }
      }
    }
    next();
  };

/** The `.d.ts` the integration injects for the `blume:*` virtual modules. */
const MODULE_TYPES_FILE = "modules.d.ts";

/**
 * Where Astro writes an integration's injected types when the integration
 * never asked for its codegen dir (a config run whose `astro:config:setup`
 * was skipped — the test fixtures). Mirrors Astro's own convention.
 */
const defaultCodegenDir = (root: URL): URL =>
  new URL(".astro/integrations/blume/", root);

/**
 * Blume's Astro integration. Mounts user-authored pages from `pages/` into the
 * generated runtime via `injectRoute`, keeping each file in its original
 * location so relative imports and `getStaticPaths` keep working; declares
 * the `blume:*` virtual modules' types through `injectTypes`; and teaches the
 * dev server to honor `Accept: text/markdown`.
 */
export const blumeIntegration = (
  options: BlumeIntegrationOptions
): AstroIntegration => {
  // Astro hands out the codegen dir on `astro:config:setup`; the types are
  // injected on `astro:config:done`, once `srcDir` is final, and the
  // `blume:examples` declaration needs the path between the two.
  let codegenDir: URL | null = null;
  // The Astro root, kept for the build-artifacts scan: `astro:build:done`
  // receives no config.
  let astroRoot: URL | null = null;
  return {
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const project =
          registry().buildProject ??
          (await scanForArtifacts(
            astroRoot,
            options.buildArtifactsRoot,
            logger
          ));
        if (!project) {
          return;
        }
        // `dir` is what Astro reports as the client output — `dist/`, or
        // `dist/client` for a server build (`dist/client/<base>/` once
        // `@astrojs/cloudflare` moves it under the base, whose `_headers` the
        // writer places at the root served above it) — which is what the
        // platform serves (the Vercel adapter copies it into its Build Output
        // static tree in a later hook).
        await publishBuildArtifacts(project, fileURLToPath(dir), logger);
      },
      "astro:config:done": ({ config, injectTypes }) => {
        astroRoot = config.root;
        const from = fileURLToPath(
          codegenDir ?? defaultCodegenDir(config.root)
        );
        const examplesModule = relative(
          from,
          join(fileURLToPath(config.srcDir), "generated", "examples.ts")
        );
        injectTypes({
          content: runtimeModuleDeclarations(examplesModule),
          filename: MODULE_TYPES_FILE,
        });
      },
      "astro:config:setup": ({
        addMiddleware,
        createCodegenDir,
        injectRoute,
      }) => {
        codegenDir = createCodegenDir();
        // Splices each page's icon sprite in once the page has rendered (see
        // components/icon-sprite-middleware.ts). Innermost, so a project's
        // own middleware sees the finished HTML.
        addMiddleware({
          entrypoint: "blume/components/icon-sprite-middleware.ts",
          order: "post",
        });
        for (const page of options.pages) {
          injectRoute({
            entrypoint: page.entrypoint,
            pattern: page.pattern,
            prerender: true,
          });
        }
      },
      "astro:server:setup": ({ refreshContent, server }) => {
        // Keep a handle on the dev server so Blume diagnostics can be pushed
        // to its browser error overlay (see `showBlumeErrorOverlay`), and on
        // Astro's content re-sync so a route-set change needs no restart
        // (see `refreshBlumeContent`).
        const shared = registry();
        shared.overlay = server;
        shared.refreshContent = refreshContent ?? null;
        // `astro:config:done` always runs first; the root locates the store.
        if (astroRoot) {
          watchDataStore(server, astroRoot);
        }
        // Prepend so the rewrite happens before Astro's own request handler,
        // letting the rewritten URL resolve to the `.md` endpoint.
        server.middlewares.stack.unshift({
          handle: negotiateMarkdown({
            contentRoutes: new Set(options.contentRoutes),
            homeLinkHeader: options.homeLinkHeader,
          }),
          route: "",
        });
      },
    },
    name: "blume",
  };
};

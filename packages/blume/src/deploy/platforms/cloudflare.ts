import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import { join, relative } from "pathe";

import { pageJsonPath } from "../../ai/api/paths.ts";
import { buildHomeLinkHeader } from "../../ai/link-headers.ts";
import {
  agentMarkdown,
  buildRawMarkdown,
  markdownRoutePaths,
  markdownTokenCount,
} from "../../ai/markdown.ts";
import type { BlumeProject } from "../../core/project-graph.ts";
import type { ProjectContext } from "../../core/types.ts";
import { CLOUDFLARE_ADAPTER_PACKAGE } from "../adapters/cloudflare.ts";
import {
  injectWorkerNegotiation,
  NEGOTIATION_WORKER_FILE,
} from "../cloudflare-negotiation.ts";
import { platformRedirects } from "../redirects.ts";
import { REDIRECTS_FILE } from "./netlify.ts";
import { clientDir, distDir, toSiteUrl } from "./paths.ts";
import type { BuildLog, DeployPlatform } from "./types.ts";

const WRANGLER_CONFIG_FILES = [
  "wrangler.jsonc",
  "wrangler.json",
  "wrangler.toml",
];

/**
 * The adapter's constructor options. Every Blume HTML route prerenders (the
 * only server routes are API endpoints), so images are optimized at build
 * time with sharp: the adapter's default (`cloudflare-binding`) would instead
 * declare a runtime `IMAGES` binding in the generated wrangler config that
 * nothing uses. A wrangler config at the project root is pointed at
 * explicitly, because the adapter would otherwise look beside the Astro
 * root — the hidden runtime — and the dev workerd runtime would miss
 * `nodejs_compat`.
 */
const adapterOptions = (context: ProjectContext) => {
  const options = { imageService: "compile", prerenderEnvironment: "node" };
  const wranglerPath = WRANGLER_CONFIG_FILES.map((file) =>
    join(context.root, file)
  ).find((file) => existsSync(file));
  if (!wranglerPath) {
    return options;
  }
  let configPath = relative(context.outDir, wranglerPath);
  // The wrangler config always lives at the project root, above the `.blume`
  // runtime, so `relative` yields a `../…` path; normalize the theoretical
  // sibling case to an explicit `./` so it reads as relative.
  if (!configPath.startsWith(".") && !configPath.startsWith("/")) {
    configPath = `./${configPath}`;
  }
  return { ...options, configPath };
};

const warnNegotiationSkipped = (log: BuildLog): void =>
  log.warn(
    "Could not wire Accept: text/markdown negotiation into dist/server/wrangler.json — raw Markdown stays available at the .md URLs."
  );

/**
 * Wire `Accept: text/markdown` negotiation into a server build. The ASSETS
 * binding serves the prerendered content pages before the Worker runs — and
 * even a request that reaches the Worker is answered by the adapter's handler
 * from that binding, ahead of the only place middleware runs — so the
 * negotiation lives in a generated wrapper Worker, routed to by
 * `assets.run_worker_first` (see `deploy/cloudflare-negotiation.ts`). Both
 * pieces are spliced into the adapter's emitted `dist/server` bundle.
 */
export const emitCloudflareNegotiation = async (
  project: BlumeProject,
  log: BuildLog
): Promise<void> => {
  const { config, context } = project;
  const serverDir = join(distDir(context), "server");
  const wranglerPath = join(serverDir, "wrangler.json");
  if (!existsSync(wranglerPath)) {
    warnNegotiationSkipped(log);
    return;
  }
  const routePaths = markdownRoutePaths(project);
  // The homepage mirror is served from the static layer, so its
  // `x-markdown-tokens` estimate rides the wrapper Worker, mirroring the
  // Vercel routing config.
  const rawMarkdown = await buildRawMarkdown(project);
  const home = rawMarkdown["/"];
  const injected = injectWorkerNegotiation(
    await readFile(wranglerPath, "utf-8"),
    {
      base: config.deployment.options.base,
      // The manifest routes guard the wrapper's redirect table; `routePaths`
      // also carries the synthesized homepage mirror, which must not block a
      // configured root redirect.
      contentRoutePaths: project.manifest.routes.map((route) => route.path),
      homeLinkHeader: buildHomeLinkHeader(config, routePaths),
      homeTokens: home ? markdownTokenCount(agentMarkdown(home)) : undefined,
      // Exactly the per-page JSON documents the API emits (see `pageParams`):
      // the non-hidden routes with agent Markdown, when the API is on.
      pageJsonPaths: config.ai.api
        ? project.manifest.routes
            .filter(
              (route) => !route.hidden && rawMarkdown[route.path] !== undefined
            )
            .map((route) => pageJsonPath(route.path))
        : [],
      // The wrapper Worker matches full served URLs, so the redirects are
      // based the same way the platform files are — it answers any the
      // worker-first rules claim, where `_redirects` is never consulted and
      // Astro would default their status.
      redirects: platformRedirects(config),
      routePaths,
    }
  );
  if (injected === null) {
    warnNegotiationSkipped(log);
    return;
  }
  await writeFile(
    join(serverDir, NEGOTIATION_WORKER_FILE),
    injected.worker,
    "utf-8"
  );
  await writeFile(wranglerPath, injected.wrangler, "utf-8");
  log.success(
    "Wired Accept: text/markdown negotiation into the Cloudflare Worker"
  );
};

/**
 * Cloudflare Workers and Pages. A server build emits the Worker into
 * `dist/server` and serves `dist/client` through the ASSETS binding, which
 * honors `_headers` from that directory exactly as Pages does — so the file
 * applies to both output modes here. Without a configured driver the adapter
 * force-enables KV-backed sessions and declares a `SESSION` binding that
 * `wrangler deploy` then demands a namespace for, even though Blume never
 * reads `Astro.session`; `session: false` opts the project out.
 */
export const cloudflarePlatform: DeployPlatform = {
  astro: {
    config: { session: false },
    options: adapterOptions,
    package: CLOUDFLARE_ADAPTER_PACKAGE,
  },
  env: {
    detect: (env) => Boolean(env.CF_PAGES),
    site: (env) => toSiteUrl(env.CF_PAGES_URL),
  },
  finalizeBuild: async ({ isolated, log, project }) => {
    // The wrapper Worker is a deploy artifact; an isolated verify skips it.
    if (!isolated) {
      await emitCloudflareNegotiation(project, log);
    }
    return true;
  },
  hiddenRuntime: {
    ignoreDir: null,
    showProjectRoot: false,
    surfacePath: null,
  },
  kind: "cloudflare",
  negotiatesMarkdown: true,
  readsHeaderFiles: { server: true, static: true },
  redirectFiles: [REDIRECTS_FILE],
  serverOutputDir: distDir,
  serverStaticDir: clientDir,
};

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { basename, dirname, join, relative, resolve } from "pathe";

import { pageJsonPath } from "../../ai/api/paths.ts";
import { buildHomeLinkHeader } from "../../ai/link-headers.ts";
import {
  agentMarkdown,
  buildRawMarkdown,
  markdownRoutePaths,
  markdownTokenCount,
} from "../../ai/markdown.ts";
import { normalizeBasePath } from "../../core/base-path.ts";
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
  // The 404 twins the wrapper may substitute for the HTML shell; only wired
  // when the build actually emitted them (a project that owns `/404` gets
  // neither), like the Vercel routing config. The adapter writes the
  // prerendered files under the deployment base (`dist/client/<base>/`),
  // where the wrapper fetches them from.
  const staticDir = join(
    clientDir(context),
    normalizeBasePath(config.deployment.options.base)
  );
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
      notFound: {
        json: existsSync(join(staticDir, "404.json")),
        markdown: existsSync(join(staticDir, "404.md")),
      },
      // Exactly the per-page JSON documents the API emits (see `pageParams`):
      // the non-hidden routes with agent Markdown, when the API is on.
      pageJsonPaths: config.agents.api
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
      redirects: platformRedirects(project),
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
 * Where Cloudflare's deploy tooling looks for the redirect to the built
 * config, relative to the directory `wrangler deploy` runs in (or any parent).
 */
const DEPLOY_CONFIG = join(".wrangler", "deploy", "config.json");

/** The redirect file the Cloudflare Vite plugin writes. */
interface DeployConfig {
  auxiliaryWorkers?: { configPath: string }[];
  configPath: string;
  prerenderWorkerConfigPath?: string;
}

/**
 * Point `wrangler deploy` run from the project root at the built Worker.
 * The adapter's Vite plugin writes its redirect beside the Astro root — the
 * hidden `.blume` runtime, where nobody runs wrangler — and wrangler only
 * looks in the working directory and its parents, so from the project root it
 * finds no config and fails with "Could not detect a directory containing
 * static files". This writes the same redirect at the project root, its paths
 * rebased there. A user wrangler config at the project root stays compatible:
 * wrangler accepts a redirect in the same directory's `.wrangler/deploy/`.
 */
export const emitCloudflareDeployConfig = async (
  context: ProjectContext
): Promise<void> => {
  const builtConfig = join(distDir(context), "server", "wrangler.json");
  if (!existsSync(builtConfig)) {
    return;
  }
  const source = join(context.outDir, DEPLOY_CONFIG);
  const target = join(context.root, DEPLOY_CONFIG);
  const rebase = (path: string): string =>
    relative(dirname(target), resolve(dirname(source), path));
  const deployConfig: DeployConfig = existsSync(source)
    ? JSON.parse(await readFile(source, "utf-8"))
    : { configPath: relative(dirname(source), builtConfig) };
  const rebased: DeployConfig = {
    auxiliaryWorkers: (deployConfig.auxiliaryWorkers ?? []).map((worker) => ({
      configPath: rebase(worker.configPath),
    })),
    configPath: rebase(deployConfig.configPath),
  };
  if (deployConfig.prerenderWorkerConfigPath) {
    rebased.prerenderWorkerConfigPath = rebase(
      deployConfig.prerenderWorkerConfigPath
    );
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(rebased)}\n`, "utf-8");
};

/**
 * The name the Worker gets when the build names it: the generated runtime's
 * package name, which every Blume site shares. Left as is, two sites deployed
 * to one account would overwrite each other's Worker.
 */
const RUNTIME_WORKER_NAME = "blume-runtime";

/**
 * A Worker name from free text: lowercase letters, digits, and dashes, no
 * leading or trailing dash, at most 63 characters (a Worker name is also a
 * `workers.dev` hostname label).
 */
const toWorkerName = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/[^\da-z]+/gu, "-")
    .slice(0, 63)
    .replaceAll(/^-+|-+$/gu, "");

/**
 * The Worker name for a project that doesn't name its own: the project's
 * `package.json` name (a scope folded in, `@acme/docs` → `acme-docs`), else the
 * site's hostname, else the project folder's name.
 */
const projectWorkerName = async (
  project: BlumeProject
): Promise<string | undefined> => {
  const { config, context } = project;
  const packageFile = join(context.root, "package.json");
  const manifest: { name?: string } = existsSync(packageFile)
    ? JSON.parse(await readFile(packageFile, "utf-8"))
    : {};
  const { site } = config.deployment.options;
  return [
    String(manifest.name ?? ""),
    site ? new URL(site).hostname : "",
    basename(context.root),
  ]
    .map(toWorkerName)
    .find((name) => name.length > 0);
};

/**
 * Name the built Worker after the project when it still carries the shared
 * runtime name. A name set in the project's own wrangler config reaches the
 * built config instead, and is left alone.
 */
export const nameCloudflareWorker = async (
  project: BlumeProject,
  log: BuildLog
): Promise<void> => {
  const wranglerPath = join(
    distDir(project.context),
    "server",
    "wrangler.json"
  );
  if (!existsSync(wranglerPath)) {
    return;
  }
  // Only the two name fields are read; every other key rides through as parsed.
  const wrangler: { name?: string; topLevelName?: string } = JSON.parse(
    await readFile(wranglerPath, "utf-8")
  );
  const name = await projectWorkerName(project);
  if (wrangler.name !== RUNTIME_WORKER_NAME || name === undefined) {
    return;
  }
  wrangler.name = name;
  if (wrangler.topLevelName === RUNTIME_WORKER_NAME) {
    wrangler.topLevelName = name;
  }
  await writeFile(wranglerPath, JSON.stringify(wrangler), "utf-8");
  log.info(
    `Named the Cloudflare Worker "${name}"; set "name" in a wrangler.jsonc at the project root to choose another.`
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
    // The Worker's name, the wrapper Worker, and the deploy redirect are
    // deploy artifacts; an isolated verify skips them.
    if (!isolated) {
      await nameCloudflareWorker(project, log);
      await emitCloudflareNegotiation(project, log);
      await emitCloudflareDeployConfig(project.context);
    }
    return true;
  },
  hiddenRuntime: {
    // The redirected deploy config `wrangler deploy` reads from the project
    // root lands in `.wrangler/`, a build artifact like Vercel's `.vercel/`.
    ignoreDir: ".wrangler/",
    showProjectRoot: false,
    surfacePath: null,
  },
  kind: "cloudflare",
  negotiatesMarkdown: true,
  previewDeploy: null,
  readsHeaderFiles: { server: true, static: true },
  redirectFiles: [REDIRECTS_FILE],
  // The adapter points `build.client` at `dist/client/<base>/` for a server
  // build, and hoists its own `_headers`/`_redirects` back up to `dist/client`.
  serverClientUnderBase: true,
  serverOutputDir: distDir,
  serverStaticDir: clientDir,
};

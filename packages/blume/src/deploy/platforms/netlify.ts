import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import { join } from "pathe";

import { buildHomeLinkHeader } from "../../ai/link-headers.ts";
import { markdownRoutePaths } from "../../ai/markdown.ts";
import type { BlumeProject } from "../../core/project-graph.ts";
import { NETLIFY_ADAPTER_PACKAGE } from "../adapters/netlify.ts";
import { buildNetlifyConfigHeaders } from "../headers.ts";
import type { NetlifyConfigHeaders } from "../headers.ts";
import { buildNetlifyRedirects } from "../redirects.ts";
import { distDir, toSiteUrl } from "./paths.ts";
import type { BuildLog, DeployPlatform, RedirectFile } from "./types.ts";

/**
 * `_redirects`, the format Netlify and Cloudflare Pages/Workers read, in the
 * form both accept: a static build for Cloudflare, or for no named host.
 */
export const REDIRECTS_FILE: RedirectFile = {
  build: buildNetlifyRedirects,
  name: "_redirects",
};

/**
 * `_redirects` for a `netlify()` static build, every rule forced (`301!`).
 * Astro writes a redirect page at each `from` (`dist/old/index.html`), and
 * Netlify serves a file that exists ahead of an unforced rule, so without the
 * flag that page would answer with a 200 instead of the redirect.
 */
export const NETLIFY_REDIRECTS_FILE: RedirectFile = {
  build: (redirects) => buildNetlifyRedirects(redirects, true),
  name: "_redirects",
};

/** The Frameworks API config, once the build surfaced it to the project root. */
export const NETLIFY_CONFIG_FILE = join(".netlify", "v1", "config.json");

/**
 * Carry the static header rules into a server build. A static `netlify()`
 * build gets them from `_headers` (see `deploy/artifacts.ts`), but a server
 * build's header rules go in the Frameworks API config the adapter writes
 * (`.netlify/v1/config.json`, beside its own `Cache-Control` rule for
 * `/_astro/*`), which follows the same rules as `netlify.toml`'s
 * `[[headers]]`: the charset on the raw Markdown and text files, the homepage
 * `Link` header, the discovery files' media types and CORS header, and the
 * sandbox on downloaded SVGs, which Netlify serves from the publish directory
 * as static files, so the prerendered endpoint's own headers never ship.
 */
export const emitNetlifyHeaders = async (
  project: BlumeProject,
  log: BuildLog
): Promise<void> => {
  const { config, context } = project;
  const configPath = join(context.root, NETLIFY_CONFIG_FILE);
  if (!existsSync(configPath)) {
    log.warn(
      `Could not find Netlify's deploy config at ${configPath}, so the site is served without its header rules (the homepage Link header, the discovery files' media types and CORS header, and the sandbox on downloaded SVGs).`
    );
    return;
  }
  // Only `headers` is read; every other key rides through as parsed.
  const frameworks: { headers?: NetlifyConfigHeaders[] } = JSON.parse(
    await readFile(configPath, "utf-8")
  );
  const ours = buildNetlifyConfigHeaders(
    config,
    buildHomeLinkHeader(config, markdownRoutePaths(project))
  );
  // A second pass over the same build replaces its own entries.
  const paths = new Set(ours.map((entry) => entry.for));
  frameworks.headers = [
    ...(frameworks.headers ?? []).filter((entry) => !paths.has(entry.for)),
    ...ours,
  ];
  await writeFile(configPath, JSON.stringify(frameworks), "utf-8");
};

/**
 * Netlify. A server build runs on Netlify Functions from the Frameworks API
 * tree the adapter writes to `.netlify/v1`, relative to the Astro root —
 * which for Blume is the hidden `.blume` runtime, so the tree is moved up to
 * the project root after the build (the `.netlify/build` sibling is only the
 * intermediate SSR bundle, already traced into `v1/functions`, and moving
 * `v1` alone keeps the `.netlify/state.json` from `netlify link` intact).
 * Static assets are served from `dist/` either way.
 */
export const netlifyPlatform: DeployPlatform = {
  astro: {
    config: {},
    options: () => ({}),
    package: NETLIFY_ADAPTER_PACKAGE,
  },
  env: {
    detect: (env) => Boolean(env.NETLIFY),
    // Fall through per *resolved* value, not per variable — a platform can
    // set a var to the empty string, which `??` on the raw values treats as
    // present, dead-ending the chain and silently losing the site URL.
    site: (env) =>
      toSiteUrl(env.URL) ??
      toSiteUrl(env.DEPLOY_PRIME_URL) ??
      toSiteUrl(env.DEPLOY_URL),
  },
  finalizeBuild: async ({ isolated, log, project }) => {
    // The Frameworks API config is a deploy artifact; an isolated verify
    // never surfaces it.
    if (!isolated) {
      await emitNetlifyHeaders(project, log);
    }
    return true;
  },
  hiddenRuntime: {
    ignoreDir: ".netlify/",
    showProjectRoot: false,
    surfacePath: ".netlify/v1",
  },
  kind: "netlify",
  negotiatesMarkdown: false,
  // @astrojs/netlify declares no preview entrypoint.
  previewDeploy: "netlify deploy",
  // Netlify reads `_headers` from the publish directory of a static deploy.
  // A server build's static assets ride the Frameworks API tree instead,
  // where the file has never been applied, so `finalizeBuild` writes the
  // same rules into that tree's config.
  readsHeaderFiles: { server: false, static: true },
  redirectFiles: [NETLIFY_REDIRECTS_FILE],
  serverClientUnderBase: false,
  serverOutputDir: distDir,
  serverStaticDir: distDir,
};

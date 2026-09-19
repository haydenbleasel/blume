import { NETLIFY_ADAPTER_PACKAGE } from "../adapters/netlify.ts";
import { buildNetlifyRedirects } from "../redirects.ts";
import { distDir, toSiteUrl } from "./paths.ts";
import type { DeployPlatform, RedirectFile } from "./types.ts";

/** `_redirects`, the format Netlify and Cloudflare Pages/Workers read. */
export const REDIRECTS_FILE: RedirectFile = {
  build: buildNetlifyRedirects,
  name: "_redirects",
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
  finalizeBuild: null,
  hiddenRuntime: {
    ignoreDir: ".netlify/",
    showProjectRoot: false,
    surfacePath: ".netlify/v1",
  },
  kind: "netlify",
  negotiatesMarkdown: false,
  // Netlify reads `_headers` from the publish directory of a static deploy.
  // A server build's static assets ride the Frameworks API tree instead,
  // where the file has never been applied.
  readsHeaderFiles: { server: false, static: true },
  redirectFiles: [REDIRECTS_FILE],
  serverOutputDir: distDir,
  serverStaticDir: distDir,
};

import { REDIRECTS_FILE } from "./netlify.ts";
import { distDir } from "./paths.ts";
import type { DeployPlatform } from "./types.ts";
import { VERCEL_JSON_FILE } from "./vercel.ts";

/**
 * A static build for an unnamed host — the default. Nothing is known about
 * where `dist/` ends up, so the build writes every platform's redirect file
 * (`_redirects` for Netlify and Cloudflare, `vercel.json` for Vercel, plus the
 * manifest for everything else) and the `_headers` file; a host that reads
 * none of them ignores them harmlessly. The site URL is still inferred from
 * whichever platform env the build runs in.
 */
export const staticPlatform: DeployPlatform = {
  astro: null,
  env: null,
  finalizeBuild: null,
  hiddenRuntime: {
    ignoreDir: null,
    showProjectRoot: false,
    surfacePath: null,
  },
  kind: "static",
  negotiatesMarkdown: false,
  previewDeploy: null,
  readsHeaderFiles: { server: false, static: true },
  redirectFiles: [REDIRECTS_FILE, VERCEL_JSON_FILE],
  serverClientUnderBase: false,
  serverOutputDir: distDir,
  serverStaticDir: distDir,
};

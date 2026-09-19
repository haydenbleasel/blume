import { NODE_ADAPTER_PACKAGE } from "../adapters/node.ts";
import { clientDir, distDir } from "./paths.ts";
import type { DeployPlatform } from "./types.ts";

/**
 * A self-hosted Node server. The standalone server in `dist/server` serves
 * `dist/client` through its own static handler, which has no `_headers` or
 * `_redirects` support — redirects are answered at request time from the
 * Astro config, and a header file written there would be inert. No platform
 * env to detect: the site URL has to be configured.
 */
export const nodePlatform: DeployPlatform = {
  astro: {
    config: {},
    options: () => ({ mode: "standalone" }),
    package: NODE_ADAPTER_PACKAGE,
  },
  env: null,
  finalizeBuild: null,
  hiddenRuntime: {
    ignoreDir: null,
    showProjectRoot: false,
    surfacePath: null,
  },
  kind: "node",
  negotiatesMarkdown: false,
  readsHeaderFiles: { server: false, static: false },
  redirectFiles: [],
  serverOutputDir: distDir,
  serverStaticDir: clientDir,
};

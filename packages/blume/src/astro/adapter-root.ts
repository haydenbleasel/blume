import { pathToFileURL } from "node:url";

import type { AstroIntegration } from "astro";

/**
 * Present a deploy adapter with `root` pointed at the real project root rather
 * than the hidden `.blume` runtime.
 *
 * Astro's `root` and `outDir` normally sit together (`outDir` defaults to
 * `<root>/dist`), and `@astrojs/vercel` leans on that: it writes its Build
 * Output tree to `<root>/.vercel/output` and — the part that bites — traces the
 * function's dependency closure with `@vercel/nft` using a base derived from
 * `root`, silently dropping every traced file that falls outside it.
 *
 * Blume splits the two: `root` is `<project>/.blume`, so Astro resolves the
 * runtime's own `package.json` and its `node_modules` junction, while `outDir`
 * stays at `<project>/dist` so the build lands where users expect. That puts
 * `build.server` (`<outDir>/server`) *outside* `root`, so nft's base excludes
 * the server bundle entirely: the traced file list collapses to `entry.mjs`
 * alone, and the deployed function dies on its first import with
 * ERR_MODULE_NOT_FOUND — missing its chunks, its virtual middleware, and every
 * npm dependency.
 *
 * A project inside a workspace accidentally escapes this, because nft's base
 * search climbs past `.blume` to the workspace root, which does contain both
 * `dist/` and `node_modules` — which is why the bug only ever surfaced in
 * standalone projects.
 *
 * Handing the adapter the root its own `outDir` assumption implies restores the
 * invariant without moving Astro's real root: the trace covers `dist/server`
 * and `node_modules`, and the Build Output tree lands at the project root
 * natively, where `vercel deploy --prebuilt` looks for it.
 *
 * `astro:config:setup` and `astro:config:done` are the only hooks handed a
 * `config`; an adapter reads `root` from one or both and closes over it for its
 * later build hooks, so overriding it there covers the whole adapter.
 */
const stripTrailingSlashes = (value: string): string => {
  let end = value.length;

  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }

  return value.slice(0, end);
};

export const withAdapterRoot = (
  integration: AstroIntegration,
  root: string
): AstroIntegration => {
  const rootUrl = pathToFileURL(`${stripTrailingSlashes(root)}/`);
  const setup = integration.hooks["astro:config:setup"];
  const done = integration.hooks["astro:config:done"];

  return {
    ...integration,
    hooks: {
      ...integration.hooks,
      ...(setup && {
        "astro:config:setup": (options) =>
          setup({ ...options, config: { ...options.config, root: rootUrl } }),
      }),
      ...(done && {
        "astro:config:done": (options) =>
          done({ ...options, config: { ...options.config, root: rootUrl } }),
      }),
    },
  };
};

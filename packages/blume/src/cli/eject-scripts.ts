import { readFile, writeFile } from "node:fs/promises";

import { join } from "pathe";

import type { ResolvedConfig } from "../core/schema.ts";
import { searchProviderMeta } from "../search/providers.ts";

/**
 * The `blume build`-only artifacts this project's config actually produces, as
 * notice lines for the eject command. After an eject the build script runs
 * plain `astro build`, which emits none of them — printing the config-aware
 * list makes the loss explicit instead of silent (a Pagefind site would
 * otherwise eject into a build whose search fails at runtime). Each gate
 * mirrors the artifact's producer in `blume build` (cli/commands/build.ts).
 */
export const droppedArtifactNotices = (config: ResolvedConfig): string[] => {
  const notices: string[] = [];
  if (config.search.provider === "pagefind") {
    notices.push(
      'the Pagefind search index — the search UI loads it from the built site, so search will break in production. Add a post-build step: `"build": "astro build && pagefind --site dist"` (with `pagefind` installed as a devDependency).'
    );
  }
  if (searchProviderMeta(config.search.provider).syncs) {
    notices.push(
      `the hosted ${config.search.provider} index sync — new and updated pages stop being pushed; re-upload your search records after each build with the provider's API or CLI.`
    );
  }
  if (config.ai.llmsTxt.enabled) {
    notices.push("llms.txt and llms-full.txt");
  }
  if (config.deployment.site && config.seo.sitemap) {
    notices.push(
      "sitemap.xml — recreate it with the @astrojs/sitemap integration."
    );
  }
  if (config.seo.robots) {
    notices.push("robots.txt — recreate it as a public/robots.txt file.");
  }
  if (config.seo.agentReadability) {
    notices.push("agent-readability.json");
  }
  if (config.redirects.length > 0 && config.deployment.output === "static") {
    notices.push(
      "the platform redirect files (_redirects, vercel.json) — your redirects still work as Astro-generated meta-refresh pages."
    );
  }
  return notices;
};

/**
 * Rewrite the project's package.json scripts to run Astro directly. After an
 * eject the Blume CLI no longer manages the runtime, so scaffolded scripts like
 * `"dev": "blume dev"` would rebuild the removed `.blume` tree instead of
 * serving the ejected app. A missing or unreadable package.json is left alone.
 */
export const updatePackageScripts = async (root: string): Promise<void> => {
  const pkgPath = join(root, "package.json");
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
  } catch {
    return;
  }
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  pkg.scripts = {
    ...scripts,
    build: "astro build",
    dev: "astro dev",
    preview: "astro preview",
  };
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
};

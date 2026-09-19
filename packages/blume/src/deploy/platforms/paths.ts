import { dirname, join } from "pathe";

import type { ProjectContext } from "../../core/types.ts";

/** Astro's build output dir: the runtime's own `distDir`, else `<root>/dist`. */
export const distDir = (context: ProjectContext): string =>
  context.distDir ?? join(context.root, "dist");

/**
 * The `client/` half of a server build that keeps Astro's `dist/client` +
 * `dist/server` split and serves only the client half: the Node standalone
 * server's static handler reads only `build.client`, and `@astrojs/cloudflare`
 * declares `preserveBuildClientDir: true` and points the ASSETS binding in the
 * `dist/server/wrangler.json` it generates at `../client`.
 */
export const clientDir = (context: ProjectContext): string =>
  join(distDir(context), "client");

/**
 * The root a deploy adapter is shown, in place of the `.blume` runtime Astro
 * actually roots at. Adapters assume `outDir` is `<root>/dist` and resolve
 * their own output (and Vercel's dependency trace) against `root`, so the
 * root implied by Blume's `outDir` is the one that keeps that assumption
 * true. See `withAdapterRoot`.
 *
 * For a normal build that is the project root (`<project>/dist` ->
 * `<project>`). For a relocated runtime (`blume build --isolated`) it is the
 * runtime dir itself (`<runtime>/dist` -> `<runtime>`), keeping a verify
 * build's adapter output self-contained instead of overwriting the real
 * `.vercel/output`.
 */
export const adapterRoot = (context: ProjectContext): string =>
  dirname(distDir(context));

/** Prefix a bare host with `https://`; pass values that are already absolute. */
export const toSiteUrl = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return /^https?:\/\//u.test(trimmed) ? trimmed : `https://${trimmed}`;
};

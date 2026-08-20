import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";

import { dirname, join } from "pathe";

import type { ResolvedConfig } from "../core/schema.ts";
import type { ProjectContext } from "../core/types.ts";

type Adapter = NonNullable<ResolvedConfig["deployment"]["adapter"]>;

/** An optional per-adapter path, keyed by the closed adapter union. */
type AdapterPathMap = { [A in Adapter]?: string };

/**
 * Top-level directory each server adapter writes its deploy bundle into, for
 * `.gitignore` — the bundle is a build artifact, and the platform's own state
 * lives alongside it (`.vercel/project.json`, `.netlify/state.json`), so the
 * whole directory is ignored. `node` and `cloudflare` emit into `dist/`, which
 * `blume init` already ignores.
 */
export const ADAPTER_IGNORE_DIRS: AdapterPathMap = {
  netlify: ".netlify/",
  vercel: ".vercel/",
};

/**
 * Server adapters whose deploy bundle lands *outside* Astro's `outDir`, at a
 * path relative to the Astro project root. Blume points the Astro root at the
 * hidden `<root>/.blume` runtime, so these adapters write their bundle to
 * `<root>/.blume/<path>` — where the deploy platform never looks. Each value is
 * the sub-path to surface up to the real project root.
 *
 * `netlify` writes a Frameworks API tree at `.netlify/v1` (its `.netlify/build`
 * sibling is only the intermediate SSR bundle, already traced into
 * `v1/functions`); only `v1` is moved, so the `.netlify/state.json` written by
 * `netlify link` survives too. `node` and `cloudflare` emit into `dist/`
 * (already at the project root), so they are absent here and need no
 * relocation.
 *
 * `vercel` is absent for a different reason: it is shown the real project root
 * up front (see `withAdapterRoot`), because its `@vercel/nft` dependency trace
 * is rooted there too and tracing from `.blume` silently drops the function's
 * chunks and `node_modules`. Given the right root it writes its Build Output
 * tree straight to `<root>/.vercel/output`, so there is nothing left to move.
 */
export const ADAPTER_OUTPUT_PATHS: AdapterPathMap = {
  netlify: ".netlify/v1",
};

/**
 * Whether this build keeps Astro's `dist/client` + `dist/server` split and
 * serves only the `client/` half. True for Node and Cloudflare server builds:
 * the Node standalone server's static handler reads only `build.client`, and
 * `@astrojs/cloudflare` declares `preserveBuildClientDir: true` and points the
 * ASSETS binding in the `dist/server/wrangler.json` it generates at
 * `../client` — the Worker serves that directory and nothing above it. A
 * Cloudflare *static* build has no server dir to split against, so its
 * `outDir` root is what ships.
 */
export const servesClientSubdir = (
  deployment: ResolvedConfig["deployment"]
): boolean =>
  deployment.output === "server" &&
  (deployment.adapter === "node" || deployment.adapter === "cloudflare");

/**
 * Whether the platform applies a `_headers` file to the static assets it
 * serves. True for every static build (Netlify and Cloudflare Pages/Workers
 * both read it) and, additionally, for a **Cloudflare server** build: the
 * Worker serves `dist/client` through its ASSETS binding, and Workers static
 * assets honor `_headers` from that directory exactly as Pages does.
 *
 * Deliberately not true for a Node server build. Node's standalone server has
 * its own static handler with no `_headers` support, so writing the file there
 * would be inert — and reporting a header that is not applied is worse than
 * omitting it.
 *
 * A Vercel **server** build is excluded because its headers arrive through the
 * routing config instead (see `deploy/vercel-negotiation.ts`), which
 * `_headers` would duplicate rather than complement. A *static* build on the
 * Vercel adapter still returns true: Vercel ignores the file, so it is inert
 * there, matching what the old `output === "static"` gate emitted.
 */
export const readsHeaderFiles = (
  deployment: ResolvedConfig["deployment"]
): boolean =>
  deployment.output === "static" ||
  (deployment.output === "server" && deployment.adapter === "cloudflare");

/**
 * Directory whose contents the deploy platform serves as static files. Build
 * artifacts (robots.txt, sitemap.xml, llms.txt, …) must be written here to be
 * served. For a Vercel server build that is the adapter's
 * `.vercel/output/static`; for a Node or Cloudflare server build it is Astro's
 * `build.client` dir (`dist/client/` — see {@link servesClientSubdir}). Every
 * other build serves `dist/` itself, Netlify included.
 */
export const deployStaticDir = (
  config: ResolvedConfig,
  context: ProjectContext
): string => {
  const { adapter, output } = config.deployment;
  if (output === "server" && adapter === "vercel") {
    return join(context.root, ".vercel", "output", "static");
  }
  const dist = context.distDir ?? join(context.root, "dist");
  if (servesClientSubdir(config.deployment)) {
    return join(dist, "client");
  }
  return dist;
};

/** Outcome of {@link surfaceAdapterOutput}, for logging. */
export type SurfaceResult =
  | { moved: false }
  | { from: string; moved: true; to: string };

/**
 * Move a server adapter's deploy bundle out of the hidden `.blume` runtime and
 * up to the project root, where the deploy platform (and `vercel deploy
 * --prebuilt`) expects it. A no-op for static builds, for adapters that emit
 * into `dist/`, and when the expected output is absent.
 */
export const surfaceAdapterOutput = async (
  config: ResolvedConfig,
  context: ProjectContext
): Promise<SurfaceResult> => {
  const { adapter, output } = config.deployment;
  if (output !== "server" || !adapter) {
    return { moved: false };
  }
  const rel = ADAPTER_OUTPUT_PATHS[adapter];
  if (!rel) {
    return { moved: false };
  }
  const from = join(context.outDir, rel);
  const to = join(context.root, rel);
  if (!existsSync(from)) {
    return { moved: false };
  }
  await mkdir(dirname(to), { recursive: true });
  await rm(to, { force: true, recursive: true });
  // `verbatimSymlinks` keeps each symlink's target text as written. Without it,
  // `cp` resolves every relative target against the *source*, rewriting it to an
  // absolute path under `.blume` — which this function then deletes. Adapters
  // that trace dependencies into their function bundle link one package to
  // another that way (under an isolated linker — Bun's `isolated` mode, pnpm —
  // that is every external dependency the function imports), so the resolved
  // links leave the deployed function dying on its first external import with
  // ERR_MODULE_NOT_FOUND. Verbatim, the links stay relative and internal to the
  // bundle, surviving both this move and the platform's own (Vercel mounts the
  // bundle at `/var/task`).
  await cp(from, to, { recursive: true, verbatimSymlinks: true });
  await rm(from, { force: true, recursive: true });
  return { from, moved: true, to };
};

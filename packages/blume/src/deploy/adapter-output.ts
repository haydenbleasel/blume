import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";

import { dirname, join } from "pathe";

import type { ResolvedConfig } from "../core/schema.ts";
import type { ProjectContext } from "../core/types.ts";
import type { ResolvedDeployment } from "./adapters/registry.ts";
import { deployPlatform } from "./platforms/index.ts";
import { distDir } from "./platforms/paths.ts";

/**
 * Where a build's output lands. Every static build and most server builds
 * write to Astro's `outDir`; the Vercel adapter writes its Build Output tree
 * beside it instead. Each platform declares its own (see `deploy/platforms`).
 */
export const deployOutputDir = (
  config: ResolvedConfig,
  context: ProjectContext
): string => {
  const { deployment } = config;
  return deployment.options.output === "server"
    ? deployPlatform(deployment).serverOutputDir(context)
    : distDir(context);
};

/**
 * Directory whose contents the deploy platform serves as static files. Build
 * artifacts (robots.txt, sitemap.xml, llms.txt, …) must be written here to be
 * served. A static build serves `dist/` wherever it lands; a server build
 * serves what its platform declares — the Build Output tree's `static/` half
 * on Vercel, Astro's `build.client` dir (`dist/client/`) on Node and
 * Cloudflare, `dist/` on Netlify.
 */
export const deployStaticDir = (
  config: ResolvedConfig,
  context: ProjectContext
): string => {
  const { deployment } = config;
  return deployment.options.output === "server"
    ? deployPlatform(deployment).serverStaticDir(context)
    : distDir(context);
};

/**
 * Whether the platform applies a `_headers` file to the static assets it
 * serves — true where Netlify or Cloudflare read one, including a Cloudflare
 * **server** build (the Worker serves `dist/client` through its ASSETS
 * binding, which honors `_headers` exactly as Pages does), and for a static
 * build with no named host. Deliberately false where the file would be inert:
 * Node's standalone server has its own static handler with no `_headers`
 * support, and Vercel's headers arrive through the routing config instead.
 * Reporting a header that is not applied is worse than omitting it.
 */
export const readsHeaderFiles = (deployment: ResolvedDeployment): boolean =>
  deployPlatform(deployment).readsHeaderFiles[deployment.options.output];

/** Outcome of {@link surfaceAdapterOutput}, for logging. */
export type SurfaceResult =
  | { moved: false }
  | { from: string; moved: true; to: string };

/**
 * Move a server adapter's deploy bundle out of the hidden `.blume` runtime and
 * up to the project root, where the deploy platform expects it. A no-op for
 * static builds, for platforms whose bundle already lands where they look
 * (`hiddenRuntime.surfacePath` is null), and when the expected output is
 * absent.
 */
export const surfaceAdapterOutput = async (
  config: ResolvedConfig,
  context: ProjectContext
): Promise<SurfaceResult> => {
  const { deployment } = config;
  if (deployment.options.output !== "server") {
    return { moved: false };
  }
  const rel = deployPlatform(deployment).hiddenRuntime.surfacePath;
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
  try {
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
  } catch (error) {
    // SAFETY: a rejected `cp` always yields a Node system error, whose `code`
    // is the only field read here.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
    // `EPERM` is Windows refusing to create a symlink without Developer Mode
    // or admin rights (the same answer `symlinkDir` handles for the deps
    // link). Copy through the links instead: each becomes an ordinary
    // directory holding its target's files — bigger, but self-contained.
    await rm(to, { force: true, recursive: true });
    await cp(from, to, { dereference: true, recursive: true });
  }
  await rm(from, { force: true, recursive: true });
  return { from, moved: true, to };
};

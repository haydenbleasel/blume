import { z } from "zod";

import type { AdapterDescriptor, JsonValue } from "../../core/adapter.ts";

/** Build output mode: prerendered HTML only, or a server that can also answer requests. */
export type DeployOutput = "static" | "server";

/** The options every host adapter maps itself. */
export interface DeployNamedOptions {
  /** Base path when the site is served from a subdirectory (`/docs`). */
  base?: string;
  /**
   * Build output mode. Defaults to `server`: naming a host adapter is how a
   * site opts into server rendering. Pass `"static"` to keep a static build
   * on that host, with its site detection and platform files.
   */
  output?: DeployOutput;
  /**
   * Canonical site URL. Needed for absolute links, the sitemap, and OG images;
   * detected from the platform's env at build time when unset.
   */
  site?: string;
}

/**
 * Options for a host adapter: the named options plus anything else, forwarded
 * verbatim to the underlying `@astrojs/*` adapter's constructor. JSON values
 * only — the descriptor is inlined into the generated `astro.config.mjs`.
 */
export type DeployOptions = DeployNamedOptions & {
  [option: string]: JsonValue;
};

/**
 * The descriptor a host adapter factory returns and `blume.config.ts` carries
 * under `deployment`: the shared {@link AdapterDescriptor} contract, with the
 * options a host takes. Plain data, never an Astro integration — the generated
 * config imports the real adapter package itself.
 */
export type DeployAdapter<
  Kind extends string,
  Options extends DeployOptions = DeployOptions,
> = AdapterDescriptor<Kind, Options>;

/**
 * A static build for any host — the form `deployment` takes when no adapter is
 * named: `{ site, base }`, or nothing at all. `kind` is the resolved
 * discriminator; leave it unset.
 */
export interface StaticDeployment {
  /** Base path when the site is served from a subdirectory (`/docs`). */
  base?: string;
  /** The resolved kind; never needed in a config. */
  kind?: "static";
  /**
   * Canonical site URL. Needed for absolute links, the sitemap, and OG images;
   * detected from the platform's env at build time when unset.
   */
  site?: string;
}

/** The named options' schema; every host adapter extends it with `z.json()` passthrough. */
export const deployOptionsSchema = z
  .object({
    base: z.string().optional(),
    output: z.enum(["static", "server"]).optional(),
    site: z.url().optional(),
  })
  .catchall(z.json());

const NAMED_OPTIONS = new Set(["base", "output", "site"]);

/**
 * The options Blume does not name — what reaches the `@astrojs/*` adapter's
 * constructor verbatim.
 */
export const deployPassthrough = (
  options: DeployOptions
): Record<string, JsonValue> =>
  Object.fromEntries(
    Object.entries(options).filter(([key]) => !NAMED_OPTIONS.has(key))
  );

/**
 * The runtime dependency a host adapter declares: its `@astrojs/*` package,
 * which the generated `astro.config.mjs` imports for a server build and
 * nothing imports for a static one. Unset `output` means server.
 */
export const serverRuntimeDeps = (
  options: DeployNamedOptions,
  adapterPackage: string
): string[] => (options.output === "static" ? [] : [adapterPackage]);

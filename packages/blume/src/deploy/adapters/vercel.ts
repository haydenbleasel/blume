import { adapterDescriptorSchema } from "../../core/adapter.ts";
import type { DeployAdapter, DeployOptions } from "./types.ts";
import { deployOptionsSchema, serverRuntimeDeps } from "./types.ts";

/** The Astro adapter package a Vercel server build imports. */
export const VERCEL_ADAPTER_PACKAGE = "@astrojs/vercel";

/**
 * Options for {@link vercel}: `output`, `site`, and `base`, plus any option of
 * `@astrojs/vercel` forwarded verbatim (`isr`, `maxDuration`, `imageService`,
 * `webAnalytics`, …).
 */
export type VercelOptions = DeployOptions;

export type VercelAdapter = DeployAdapter<"vercel">;

export const vercelOptionsSchema = deployOptionsSchema;

export const vercelAdapterSchema = adapterDescriptorSchema(
  "vercel",
  vercelOptionsSchema
);

/**
 * Vercel. A server build writes the Build Output tree to `.vercel/output`,
 * audits the function bundle for imports the platform's dependency trace
 * dropped, and wires `Accept: text/markdown` negotiation into the routing
 * config. `@astrojs/vercel` is one of Blume's own dependencies.
 */
export const vercel = (options: VercelOptions = {}): VercelAdapter => ({
  kind: "vercel",
  options,
  requiredSecrets: [],
  runtimeDeps: serverRuntimeDeps(options, VERCEL_ADAPTER_PACKAGE),
});

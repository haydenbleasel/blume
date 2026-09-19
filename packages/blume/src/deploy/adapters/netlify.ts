import { adapterDescriptorSchema } from "../../core/adapter.ts";
import type { DeployAdapter, DeployOptions } from "./types.ts";
import { deployOptionsSchema, serverRuntimeDeps } from "./types.ts";

/** The Astro adapter package a Netlify server build imports. */
export const NETLIFY_ADAPTER_PACKAGE = "@astrojs/netlify";

/**
 * Options for {@link netlify}: `output`, `site`, and `base`, plus any option
 * of `@astrojs/netlify` forwarded verbatim (`edgeMiddleware`, `imageCDN`,
 * `cacheOnDemandPages`, …).
 */
export type NetlifyOptions = DeployOptions;

export type NetlifyAdapter = DeployAdapter<"netlify">;

export const netlifyOptionsSchema = deployOptionsSchema;

export const netlifyAdapterSchema = adapterDescriptorSchema(
  "netlify",
  netlifyOptionsSchema
);

/**
 * Netlify. A server build runs on Netlify Functions from the Frameworks API
 * tree the adapter writes to `.netlify/v1`. `@astrojs/netlify` is an optional
 * peer: install it in the project (`npm install @astrojs/netlify`).
 */
export const netlify = (options: NetlifyOptions = {}): NetlifyAdapter => ({
  kind: "netlify",
  options,
  requiredSecrets: [],
  runtimeDeps: serverRuntimeDeps(options, NETLIFY_ADAPTER_PACKAGE),
});

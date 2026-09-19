import { adapterDescriptorSchema } from "../../core/adapter.ts";
import type { DeployAdapter, DeployOptions } from "./types.ts";
import { deployOptionsSchema, serverRuntimeDeps } from "./types.ts";

/** The Astro adapter package a Cloudflare server build imports. */
export const CLOUDFLARE_ADAPTER_PACKAGE = "@astrojs/cloudflare";

/**
 * Options for {@link cloudflare}: `output`, `site`, and `base`, plus any
 * option of `@astrojs/cloudflare` forwarded verbatim (`platformProxy`,
 * `routes`, `cloudflareModules`, …). Blume sets `prerenderEnvironment`,
 * `imageService`, and `configPath` itself; an option you pass wins.
 */
export type CloudflareOptions = DeployOptions;

export type CloudflareAdapter = DeployAdapter<"cloudflare">;

export const cloudflareOptionsSchema = deployOptionsSchema;

export const cloudflareAdapterSchema = adapterDescriptorSchema(
  "cloudflare",
  cloudflareOptionsSchema
);

/**
 * Cloudflare Workers and Pages. A server build emits a Worker into
 * `dist/server` (with a generated wrapper that answers `Accept:
 * text/markdown`) and serves `dist/client` through the ASSETS binding.
 * `@astrojs/cloudflare` is an optional peer: install it in the project
 * (`npm install @astrojs/cloudflare`).
 */
export const cloudflare = (
  options: CloudflareOptions = {}
): CloudflareAdapter => ({
  kind: "cloudflare",
  options,
  requiredSecrets: [],
  runtimeDeps: serverRuntimeDeps(options, CLOUDFLARE_ADAPTER_PACKAGE),
});

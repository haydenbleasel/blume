import { z } from "zod";

import { adapterDescriptorSchema } from "../../core/adapter.ts";
import type { DeployAdapter, DeployOptions } from "./types.ts";
import { deployOptionsSchema, serverRuntimeDeps } from "./types.ts";

/** The Astro adapter package a Node server build imports. */
export const NODE_ADAPTER_PACKAGE = "@astrojs/node";

/**
 * A host the server trusts forwarded headers for, in Astro's
 * `security.allowedDomains` shape: each field set must match.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- interface loses the implicit index signature a deploy option's JsonValue needs
export type NodeAllowedDomain = {
  /** The host, like `docs.example.com`; `*.example.com` matches subdomains. */
  hostname?: string;
  /** The port, as a string. */
  port?: string;
  /** The scheme, like `https`. */
  protocol?: string;
};

/**
 * Options for {@link node}: `output`, `site`, `base`, and `allowedDomains`,
 * plus any option of `@astrojs/node` forwarded verbatim (`mode`,
 * `staticHeaders`, …). Blume defaults `mode` to `"standalone"`; an option you
 * pass wins. `host` and `port` are forwarded too, but `@astrojs/node`
 * replaces both with Astro's own server settings, so the standalone server
 * listens on `localhost:4321` unless the `HOST` and `PORT` environment
 * variables are set when it starts.
 */
export type NodeOptions = DeployOptions & {
  /**
   * The hosts a reverse proxy in front of the server answers for, set as
   * Astro's `security.allowedDomains`. A request whose `Host` (or
   * `X-Forwarded-Host`) matches one is trusted to name the reader in
   * `X-Forwarded-For`, which the rate limit counts by; otherwise every
   * reader counts as the proxy's address. Only list them when a proxy sets
   * that header on every request, since a reader could otherwise send their
   * own.
   */
  allowedDomains?: NodeAllowedDomain[];
};

export type NodeAdapter = DeployAdapter<"node", NodeOptions>;

export const nodeOptionsSchema = deployOptionsSchema.extend({
  allowedDomains: z
    .array(
      z.strictObject({
        hostname: z.string().min(1).optional(),
        port: z.string().min(1).optional(),
        protocol: z.string().min(1).optional(),
      })
    )
    .optional(),
});

export const nodeAdapterSchema = adapterDescriptorSchema(
  "node",
  nodeOptionsSchema
);

/**
 * A self-hosted Node server (containers, VMs). The standalone server in
 * `dist/server/entry.mjs` serves `dist/client` itself. `@astrojs/node` is one
 * of Blume's own dependencies.
 */
export const node = (options: NodeOptions = {}): NodeAdapter => ({
  kind: "node",
  options,
  requiredSecrets: [],
  runtimeDeps: serverRuntimeDeps(options, NODE_ADAPTER_PACKAGE),
});

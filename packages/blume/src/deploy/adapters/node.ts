import { adapterDescriptorSchema } from "../../core/adapter.ts";
import type { DeployAdapter, DeployOptions } from "./types.ts";
import { deployOptionsSchema, serverRuntimeDeps } from "./types.ts";

/** The Astro adapter package a Node server build imports. */
export const NODE_ADAPTER_PACKAGE = "@astrojs/node";

/**
 * Options for {@link node}: `output`, `site`, and `base`, plus any option of
 * `@astrojs/node` forwarded verbatim (`mode`, `host`, `port`, …). Blume
 * defaults `mode` to `"standalone"`; an option you pass wins.
 */
export type NodeOptions = DeployOptions;

export type NodeAdapter = DeployAdapter<"node">;

export const nodeOptionsSchema = deployOptionsSchema;

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

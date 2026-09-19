/**
 * Deployment adapters for `blume.config.ts`:
 *
 * ```ts
 * import { defineConfig } from "blume";
 * import { vercel } from "blume/deploy";
 *
 * export default defineConfig({
 *   deployment: vercel({ site: "https://docs.example.com" }),
 * });
 * ```
 *
 * Naming a host switches the build to server output on that host; leave
 * `deployment` unset (or `{ site, base }`) for a static build anywhere. Each
 * factory returns a plain descriptor (see `core/adapter.ts`) that the schema
 * validates; the generated `astro.config.mjs` imports the real `@astrojs/*`
 * adapter and passes the options through verbatim.
 */
export type { AdapterDescriptor, JsonValue } from "../../core/adapter.ts";
export { cloudflare } from "./cloudflare.ts";
export type { CloudflareAdapter, CloudflareOptions } from "./cloudflare.ts";
export { netlify } from "./netlify.ts";
export type { NetlifyAdapter, NetlifyOptions } from "./netlify.ts";
export { node } from "./node.ts";
export type { NodeAdapter, NodeOptions } from "./node.ts";
export type {
  AnyDeployAdapter,
  DeployAdapterKind,
  DeploymentInput,
  ResolvedDeployment,
  ResolvedDeployOptions,
} from "./registry.ts";
export type {
  DeployAdapter,
  DeployNamedOptions,
  DeployOptions,
  DeployOutput,
  StaticDeployment,
} from "./types.ts";
export { vercel } from "./vercel.ts";
export type { VercelAdapter, VercelOptions } from "./vercel.ts";

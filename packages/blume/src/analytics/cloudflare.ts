import { z } from "zod";

import type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";

/** The beacon script Cloudflare's dashboard snippet loads. */
export const CLOUDFLARE_BEACON_SRC =
  "https://static.cloudflareinsights.com/beacon.min.js";

/** The options {@link cloudflare} maps itself. */
export interface CloudflareNamedOptions {
  /** Site token from the Web Analytics JS snippet (`data-cf-beacon`). */
  token: string;
}

/**
 * Options for {@link cloudflare}: the token plus any other `data-cf-beacon`
 * setting, forwarded verbatim (`spa`, …). JSON values only.
 */
export type CloudflareOptions = CloudflareNamedOptions & {
  [option: string]: JsonValue;
};

export const cloudflareOptionsSchema = z
  .object({
    token: z.string().min(1),
  })
  .catchall(z.json());

export type CloudflareAdapter = AdapterDescriptor<
  "cloudflare",
  CloudflareOptions
>;

export const cloudflareAdapterSchema = adapterDescriptorSchema(
  "cloudflare",
  cloudflareOptionsSchema
);

/**
 * Cloudflare Web Analytics in manual (JS snippet) mode, for a site Cloudflare
 * doesn't proxy. A proxied zone with automatic RUM injection on needs no
 * adapter at all — listing one there would count every pageview twice.
 */
export const cloudflare = (options: CloudflareOptions): CloudflareAdapter => ({
  kind: "cloudflare",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

/**
 * The beacon tag exactly as the dashboard's snippet renders it, with the whole
 * option object as its `data-cf-beacon` JSON. The beacon tracks history
 * changes itself, so client-router navigations need no extra hook.
 */
export const cloudflareHead = (options: CloudflareOptions): HeadScript[] => [
  {
    attributes: {
      "data-cf-beacon": JSON.stringify(options),
      defer: true,
      src: CLOUDFLARE_BEACON_SRC,
    },
    content: null,
  },
];

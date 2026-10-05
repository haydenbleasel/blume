import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import { rateLimitOptionsSchema } from "./memory.ts";
import type { RateLimitOptions } from "./memory.ts";

/** The env var holding the Upstash Redis REST endpoint, unless set. */
const UPSTASH_URL_ENV = "UPSTASH_REDIS_REST_URL";

/** The env var holding the endpoint's token, unless set. */
const UPSTASH_TOKEN_ENV = "UPSTASH_REDIS_REST_TOKEN";

/** Options for {@link upstash}. */
export interface UpstashOptions extends RateLimitOptions {
  /**
   * Name of the env var holding the REST token. Defaults to
   * `UPSTASH_REDIS_REST_TOKEN`; a database added from Vercel's Marketplace
   * sets `KV_REST_API_TOKEN`.
   */
  tokenEnv?: string;
  /**
   * Name of the env var holding the REST endpoint. Defaults to
   * `UPSTASH_REDIS_REST_URL`; a database added from Vercel's Marketplace
   * sets `KV_REST_API_URL`.
   */
  urlEnv?: string;
}

export const upstashOptionsSchema = rateLimitOptionsSchema.extend({
  tokenEnv: z.string().min(1).optional(),
  urlEnv: z.string().min(1).optional(),
});

export type UpstashAdapter = AdapterDescriptor<"upstash", UpstashOptions>;

export const upstashAdapterSchema = adapterDescriptorSchema(
  "upstash",
  upstashOptionsSchema
);

/** The env vars the endpoint and its token are read from, in that order. */
export const upstashSecrets = (options: UpstashOptions): [string, string] => [
  options.urlEnv ?? UPSTASH_URL_ENV,
  options.tokenEnv ?? UPSTASH_TOKEN_ENV,
];

/**
 * Keeps the count in Upstash Redis, which every instance on every host shares,
 * so the limit holds exactly. It talks to Upstash's REST API, so there is
 * nothing to install; the endpoint and token come from
 * `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, or the env vars
 * `urlEnv` and `tokenEnv` name.
 */
export const upstash = (options: UpstashOptions = {}): UpstashAdapter => ({
  kind: "upstash",
  options,
  requiredSecrets: upstashSecrets(options),
  runtimeDeps: [],
});

import { z } from "zod";

import { cloudflareRateLimitAdapterSchema } from "./cloudflare.ts";
import { memory, memoryAdapterSchema } from "./memory.ts";
import { unkeyAdapterSchema } from "./unkey.ts";
import { upstashAdapterSchema } from "./upstash.ts";

const ADAPTER_HINT =
  'rateLimit takes one adapter — e.g. `rateLimit: upstash()` or `rateLimit: memory({ requests: 60 })`, imported from "blume/ratelimit" — or `false` to turn it off.';

/** The configured rate limiter, as its factory returned it. */
export const rateLimitAdapterSchema = z.discriminatedUnion("kind", [
  cloudflareRateLimitAdapterSchema,
  memoryAdapterSchema,
  upstashAdapterSchema,
  unkeyAdapterSchema,
]);

export type RateLimitAdapter = z.output<typeof rateLimitAdapterSchema>;

/**
 * `blume.config.rateLimit`: how the server routes a reader can call (the
 * assistant, the API playground proxy, server-side search) limit requests
 * per reader. On by default with `memory()`; `false` turns it off (`null`
 * once resolved).
 */
export const rateLimitConfigSchema = z
  .union([z.literal(false), rateLimitAdapterSchema], { error: ADAPTER_HINT })
  .optional()
  .transform((adapter) => (adapter === false ? null : (adapter ?? memory())));

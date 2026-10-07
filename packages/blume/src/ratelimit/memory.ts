import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";

/** How many requests a reader gets per window, unless set. */
export const DEFAULT_REQUESTS = 30;

/** The window those requests are counted over, in seconds, unless set. */
export const DEFAULT_WINDOW = 600;

/** The limit every rate limiter takes: a count of requests per window. */
export interface RateLimitOptions {
  /** Requests each reader may make per window, per route. */
  requests?: number;
  /** The window, in seconds. */
  window?: number;
}

export const rateLimitOptionsSchema = z.strictObject({
  requests: z.number().int().positive().optional(),
  window: z.number().int().positive().optional(),
});

export type MemoryAdapter = AdapterDescriptor<"memory", RateLimitOptions>;

export const memoryAdapterSchema = adapterDescriptorSchema(
  "memory",
  rateLimitOptionsSchema
);

/**
 * Counts each reader's requests in the server's own memory, the default. On
 * a server that runs as one process (`node()`) the count is exact; on a
 * platform that runs many short-lived instances (Vercel, Netlify,
 * Cloudflare) each instance keeps its own, so it stops a burst from one
 * reader rather than enforcing the limit exactly. For that, share the count
 * with `upstash()`, `cloudflare()`, or `unkey()`.
 */
export const memory = (options: RateLimitOptions = {}): MemoryAdapter => ({
  kind: "memory",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

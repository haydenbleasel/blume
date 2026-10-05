/**
 * Rate limiters for `blume.config.ts`. The server routes a reader can call —
 * the assistant, the API playground proxy, and server-side search — limit
 * each reader (by IP address) to a number of requests per window, answering
 * `429 Too Many Requests` past it:
 *
 * ```ts
 * import { defineConfig } from "blume";
 * import { upstash } from "blume/ratelimit";
 *
 * export default defineConfig({
 *   rateLimit: upstash({ requests: 30, window: 600 }),
 * });
 * ```
 *
 * `memory()` is on by default; `rateLimit: false` turns limiting off. Each
 * factory returns a plain descriptor (see `core/adapter.ts`), and the
 * generated routes count with `runtime.ts`.
 */
export type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
export { cloudflare } from "./cloudflare.ts";
export type {
  CloudflareRateLimitAdapter,
  CloudflareRateLimitOptions,
} from "./cloudflare.ts";
export { memory } from "./memory.ts";
export type { MemoryAdapter, RateLimitOptions } from "./memory.ts";
export type { RateLimitAdapter } from "./schema.ts";
export { upstash } from "./upstash.ts";
export type { UpstashAdapter, UpstashOptions } from "./upstash.ts";

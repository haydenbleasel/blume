/**
 * Analytics adapters for `blume.config.ts`:
 *
 * ```ts
 * import { defineConfig } from "blume";
 * import { cloudflare, posthog, script, vercel } from "blume/analytics";
 *
 * export default defineConfig({
 *   analytics: [posthog({ key: "phc_…" }), vercel(), script({ src: "…" })],
 * });
 * ```
 *
 * Each factory returns a plain descriptor (see `core/adapter.ts`) that the
 * schema validates and the generated site inlines as a literal; nothing here
 * runs in the browser.
 */
export type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
export { cloudflare } from "./cloudflare.ts";
export type { CloudflareAdapter, CloudflareOptions } from "./cloudflare.ts";
export { posthog } from "./posthog.ts";
export type { PosthogAdapter, PosthogOptions } from "./posthog.ts";
export type { AnalyticsAdapter } from "./schema.ts";
export { script } from "./script.ts";
export type { ScriptAdapter, ScriptOptions } from "./script.ts";
export { vercel } from "./vercel.ts";
export type { VercelAdapter, VercelOptions } from "./vercel.ts";

/**
 * Analytics adapters for `blume.config.ts`:
 *
 * ```ts
 * import { defineConfig } from "blume";
 * import { plausible, posthog, script, vercel } from "blume/analytics";
 *
 * export default defineConfig({
 *   analytics: [
 *     posthog({ key: "phc_…" }),
 *     vercel(),
 *     plausible({ domain: "docs.example.com" }),
 *     script({ src: "…" }),
 *   ],
 * });
 * ```
 *
 * Each factory returns a plain descriptor (see `core/adapter.ts`) that the
 * schema validates and the generated site inlines as a literal; nothing here
 * runs in the browser.
 */
export type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
export { adobe } from "./adobe.ts";
export type { AdobeAdapter, AdobeOptions } from "./adobe.ts";
export { amplitude } from "./amplitude.ts";
export type { AmplitudeAdapter, AmplitudeOptions } from "./amplitude.ts";
export { clarity } from "./clarity.ts";
export type { ClarityAdapter, ClarityOptions } from "./clarity.ts";
export { clearbit } from "./clearbit.ts";
export type { ClearbitAdapter, ClearbitOptions } from "./clearbit.ts";
export { cloudflare } from "./cloudflare.ts";
export type { CloudflareAdapter, CloudflareOptions } from "./cloudflare.ts";
export { databuddy } from "./databuddy.ts";
export type { DatabuddyAdapter, DatabuddyOptions } from "./databuddy.ts";
export { fathom } from "./fathom.ts";
export type { FathomAdapter, FathomOptions } from "./fathom.ts";
export { googleAnalytics } from "./google-analytics.ts";
export type {
  GoogleAnalyticsAdapter,
  GoogleAnalyticsOptions,
} from "./google-analytics.ts";
export { googleTagManager } from "./google-tag-manager.ts";
export type {
  GoogleTagManagerAdapter,
  GoogleTagManagerOptions,
} from "./google-tag-manager.ts";
export { heap } from "./heap.ts";
export type { HeapAdapter, HeapOptions } from "./heap.ts";
export { hightouch } from "./hightouch.ts";
export type { HightouchAdapter, HightouchOptions } from "./hightouch.ts";
export { hotjar } from "./hotjar.ts";
export type { HotjarAdapter, HotjarOptions } from "./hotjar.ts";
export { logrocket } from "./logrocket.ts";
export type { LogrocketAdapter, LogrocketOptions } from "./logrocket.ts";
export { mixpanel } from "./mixpanel.ts";
export type {
  MixpanelAdapter,
  MixpanelOptions,
  MixpanelRegion,
} from "./mixpanel.ts";
export { oneDollarStats } from "./one-dollar-stats.ts";
export type {
  OneDollarStatsAdapter,
  OneDollarStatsOptions,
} from "./one-dollar-stats.ts";
export { pirsch } from "./pirsch.ts";
export type { PirschAdapter, PirschOptions } from "./pirsch.ts";
export { plausible } from "./plausible.ts";
export type { PlausibleAdapter, PlausibleOptions } from "./plausible.ts";
export { posthog } from "./posthog.ts";
export type { PosthogAdapter, PosthogOptions } from "./posthog.ts";
export type { AnalyticsAdapter } from "./schema.ts";
export { script } from "./script.ts";
export type { ScriptAdapter, ScriptOptions } from "./script.ts";
export { segment } from "./segment.ts";
export type { SegmentAdapter, SegmentOptions } from "./segment.ts";
export { vercel } from "./vercel.ts";
export type { VercelAdapter, VercelOptions } from "./vercel.ts";

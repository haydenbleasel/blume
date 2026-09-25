import { z } from "zod";

import { adobeAdapterSchema } from "./adobe.ts";
import { amplitudeAdapterSchema } from "./amplitude.ts";
import { clarityAdapterSchema } from "./clarity.ts";
import { clearbitAdapterSchema } from "./clearbit.ts";
import { cloudflareAdapterSchema } from "./cloudflare.ts";
import { databuddyAdapterSchema } from "./databuddy.ts";
import { fathomAdapterSchema } from "./fathom.ts";
import { googleAnalyticsAdapterSchema } from "./google-analytics.ts";
import { googleTagManagerAdapterSchema } from "./google-tag-manager.ts";
import { heapAdapterSchema } from "./heap.ts";
import { hightouchAdapterSchema } from "./hightouch.ts";
import { hotjarAdapterSchema } from "./hotjar.ts";
import { logrocketAdapterSchema } from "./logrocket.ts";
import { mixpanelAdapterSchema } from "./mixpanel.ts";
import { oneDollarStatsAdapterSchema } from "./one-dollar-stats.ts";
import { pirschAdapterSchema } from "./pirsch.ts";
import { plausibleAdapterSchema } from "./plausible.ts";
import { posthogAdapterSchema } from "./posthog.ts";
import { scriptAdapterSchema } from "./script.ts";
import { segmentAdapterSchema } from "./segment.ts";
import { vercelAdapterSchema } from "./vercel.ts";

/** One configured analytics adapter, as its factory returned it. */
export const analyticsAdapterSchema = z.discriminatedUnion("kind", [
  adobeAdapterSchema,
  amplitudeAdapterSchema,
  clarityAdapterSchema,
  clearbitAdapterSchema,
  cloudflareAdapterSchema,
  databuddyAdapterSchema,
  fathomAdapterSchema,
  googleAnalyticsAdapterSchema,
  googleTagManagerAdapterSchema,
  heapAdapterSchema,
  hightouchAdapterSchema,
  hotjarAdapterSchema,
  logrocketAdapterSchema,
  mixpanelAdapterSchema,
  oneDollarStatsAdapterSchema,
  pirschAdapterSchema,
  plausibleAdapterSchema,
  posthogAdapterSchema,
  scriptAdapterSchema,
  segmentAdapterSchema,
  vercelAdapterSchema,
]);

export type AnalyticsAdapter = z.output<typeof analyticsAdapterSchema>;

const ARRAY_HINT =
  'analytics is a list of adapters — e.g. `analytics: [posthog({ key }), vercel(), plausible({ domain }), script({ src })]`, imported from "blume/analytics".';

/**
 * `blume.config.analytics`: the adapters to emit, in order. Unset means none.
 * A non-array (the pre-adapter object form, say) fails with the list hint;
 * element errors keep their own messages.
 */
export const analyticsConfigSchema = z
  .array(analyticsAdapterSchema, {
    error: (issue) => (issue.code === "invalid_type" ? ARRAY_HINT : undefined),
  })
  .default([]);

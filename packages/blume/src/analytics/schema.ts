import { z } from "zod";

import { cloudflareAdapterSchema } from "./cloudflare.ts";
import { posthogAdapterSchema } from "./posthog.ts";
import { scriptAdapterSchema } from "./script.ts";
import { vercelAdapterSchema } from "./vercel.ts";

/** One configured analytics adapter, as its factory returned it. */
export const analyticsAdapterSchema = z.discriminatedUnion("kind", [
  cloudflareAdapterSchema,
  posthogAdapterSchema,
  scriptAdapterSchema,
  vercelAdapterSchema,
]);

export type AnalyticsAdapter = z.output<typeof analyticsAdapterSchema>;

const ARRAY_HINT =
  'analytics is a list of adapters — e.g. `analytics: [posthog({ key }), vercel(), cloudflare({ token }), script({ src })]`, imported from "blume/analytics".';

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

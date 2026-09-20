import { z } from "zod";

import type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";
import { inlineJson } from "./inline.ts";

/** The options {@link googleAnalytics} maps itself. */
export interface GoogleAnalyticsNamedOptions {
  /** Measurement ID of the GA4 web data stream (`G-…`). */
  id: string;
}

/**
 * Options for {@link googleAnalytics}: the measurement ID plus any other
 * `gtag('config', …)` parameter, forwarded verbatim (`send_page_view`,
 * `anonymize_ip`, `cookie_domain`, `debug_mode`, …). JSON values only.
 */
export type GoogleAnalyticsOptions = GoogleAnalyticsNamedOptions & {
  [parameter: string]: JsonValue;
};

export const googleAnalyticsOptionsSchema = z
  .object({
    id: z.string().min(1),
  })
  .catchall(z.json());

export type GoogleAnalyticsAdapter = AdapterDescriptor<
  "google-analytics",
  GoogleAnalyticsOptions
>;

export const googleAnalyticsAdapterSchema = adapterDescriptorSchema(
  "google-analytics",
  googleAnalyticsOptionsSchema
);

/**
 * Google Analytics 4 through the Google tag (`gtag.js`). The measurement ID is
 * public; it names the data stream the tag reports to.
 */
export const googleAnalytics = (
  options: GoogleAnalyticsOptions
): GoogleAnalyticsAdapter => ({
  kind: "google-analytics",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

/** The Google tag loader; the measurement ID travels in its query string. */
export const GOOGLE_TAG_SRC = "https://www.googletagmanager.com/gtag/js";

/**
 * The two tags from the data stream's install instructions: the async loader
 * and the `dataLayer` bootstrap with the `config` call. Extra options ride on
 * the `config` call, and it is emitted bare when there are none, exactly as
 * the instructions print it. GA4's enhanced measurement counts history
 * changes as page views by default, so client-router navigations need no
 * extra hook here.
 */
export const googleAnalyticsHead = (
  options: GoogleAnalyticsOptions
): HeadScript[] => {
  const { id, ...parameters } = options;
  const config =
    Object.keys(parameters).length === 0
      ? `gtag("config",${inlineJson(id)});`
      : `gtag("config",${inlineJson(id)},${inlineJson(parameters)});`;
  return [
    {
      attributes: {
        async: true,
        src: `${GOOGLE_TAG_SRC}?id=${encodeURIComponent(id)}`,
      },
      content: null,
    },
    {
      attributes: {},
      content: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());${config}`,
    },
  ];
};

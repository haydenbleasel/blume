import { z } from "zod";

import type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";
import { inlineJson, spaPageviews } from "./inline.ts";

/** Segment's CDN, where `segment()` loads analytics.js from when `cdn` is unset. */
export const SEGMENT_DEFAULT_CDN = "https://cdn.segment.com";

/** The options {@link segment} maps itself. */
export interface SegmentNamedOptions {
  /**
   * Origin of a custom domain that proxies Segment's CDN, e.g.
   * `https://cdn.example.com`. Defaults to Segment's own.
   */
  cdn?: string;
  /** Write key of the JavaScript source. */
  key: string;
}

/**
 * Options for {@link segment}: the named options plus any other
 * `analytics.load` option, forwarded verbatim (`integrations`, …). JSON
 * values only.
 */
export type SegmentOptions = SegmentNamedOptions & {
  [option: string]: JsonValue;
};

export const segmentOptionsSchema = z
  .object({
    cdn: z.string().min(1).optional(),
    key: z.string().min(1),
  })
  .catchall(z.json());

export type SegmentAdapter = AdapterDescriptor<"segment", SegmentOptions>;

export const segmentAdapterSchema = adapterDescriptorSchema(
  "segment",
  segmentOptionsSchema
);

/**
 * Segment (Twilio Segment) analytics.js. The write key is meant for the
 * browser — it identifies the source the SDK reports to.
 */
export const segment = (options: SegmentOptions): SegmentAdapter => ({
  kind: "segment",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

// The SDK sends one `page()` per real page load (the snippet's own call), so
// client-router swaps are sent here.
const SEGMENT_SPA_PAGEVIEWS = spaPageviews(
  "__blumeSegmentPath",
  "analytics.page();"
);

/**
 * The install snippet, with `key` mapped to the write key, `cdn` mapped to
 * the script origin (and `analytics._cdn`, so the library fetches its
 * integrations from the same place), and everything else forwarded as the
 * load options; the object is left off when there is nothing to pass, as the
 * snippet prints it.
 */
export const segmentHead = (options: SegmentOptions): HeadScript[] => {
  const { cdn, key, ...load } = options;
  const origin = (cdn ?? SEGMENT_DEFAULT_CDN).replace(/\/+$/u, "");
  const loadCall =
    Object.keys(load).length === 0
      ? `analytics.load(${inlineJson(key)});`
      : `analytics.load(${inlineJson(key)},${inlineJson(load)});`;
  const cdnAssign =
    cdn === undefined ? "" : `analytics._cdn=${inlineJson(origin)};`;
  return [
    {
      attributes: {},
      content: `!function(){var analytics=window.analytics=window.analytics||[];if(!analytics.initialize)if(analytics.invoked)window.console&&console.error&&console.error("Segment snippet included twice.");else{analytics.invoked=!0;analytics.methods=["trackSubmit","trackClick","trackLink","trackForm","pageview","identify","reset","group","track","ready","alias","debug","page","once","off","on","addSourceMiddleware","addIntegrationMiddleware","setAnonymousId","addDestinationMiddleware"];analytics.factory=function(e){return function(){var t=Array.prototype.slice.call(arguments);t.unshift(e);analytics.push(t);return analytics}};for(var e=0;e<analytics.methods.length;e++){var key=analytics.methods[e];analytics[key]=analytics.factory(key)}analytics.load=function(key,e){var t=document.createElement("script");t.type="text/javascript";t.async=!0;t.src=${inlineJson(`${origin}/analytics.js/v1/`)}+encodeURIComponent(key)+"/analytics.min.js";var n=document.getElementsByTagName("script")[0];n.parentNode.insertBefore(t,n);analytics._loadOptions=e};analytics._writeKey=${inlineJson(key)};${cdnAssign}analytics.SNIPPET_VERSION="4.15.3";${loadCall}analytics.page();}}();${SEGMENT_SPA_PAGEVIEWS}`,
    },
  ];
};

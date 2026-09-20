import { z } from "zod";

import type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";
import { inlineJson, spaPageviews } from "./inline.ts";

/** The events API host `hightouch()` uses when `host` is unset. */
export const HIGHTOUCH_DEFAULT_HOST = "us-east-1.hightouch-events.com";

/** The options {@link hightouch} maps itself. */
export interface HightouchNamedOptions {
  /** Events API host, without a scheme. Defaults to the US East region. */
  host?: string;
  /** Write key of the event source. */
  key: string;
}

/**
 * Options for {@link hightouch}: the named options plus any other
 * `htevents.load` option, forwarded verbatim. JSON values only.
 */
export type HightouchOptions = HightouchNamedOptions & {
  [option: string]: JsonValue;
};

export const hightouchOptionsSchema = z
  .object({
    host: z.string().min(1).optional(),
    key: z.string().min(1),
  })
  .catchall(z.json());

export type HightouchAdapter = AdapterDescriptor<"hightouch", HightouchOptions>;

export const hightouchAdapterSchema = adapterDescriptorSchema(
  "hightouch",
  hightouchOptionsSchema
);

/**
 * Hightouch Events. The write key is meant for the browser — it identifies
 * the event source the SDK reports to.
 */
export const hightouch = (options: HightouchOptions): HightouchAdapter => ({
  kind: "hightouch",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

// The install snippet: a `window.htevents` queue whose `load` injects the SDK.
const HIGHTOUCH_LOADER =
  '!function(){var e=window.htevents=window.htevents||[];if(!e.initialize)if(e.invoked)window.console&&console.error&&console.error("Hightouch snippet included twice.");else{e.invoked=!0,e.methods=["trackSubmit","trackClick","trackLink","trackForm","pageview","identify","reset","group","track","ready","alias","debug","page","once","off","on","addSourceMiddleware","addIntegrationMiddleware","setAnonymousId","addDestinationMiddleware"],e.factory=function(t){return function(){var r=Array.prototype.slice.call(arguments);return r.unshift(t),e.push(r),e}};for(var t=0;t<e.methods.length;t++){var r=e.methods[t];e[r]=e.factory(r)}e.load=function(t,r){var n=document.createElement("script");n.type="text/javascript",n.async=!0,n.src="https://cdn.hightouch-events.com/browser/release/v1-latest/events.min.js";var o=document.getElementsByTagName("script")[0];o.parentNode.insertBefore(n,o),e._loadOptions=r,e._writeKey=t},e.SNIPPET_VERSION="0.0.1",';

// The SDK sends one `page()` per real page load (the snippet's own call), so
// client-router swaps are sent here.
const HIGHTOUCH_SPA_PAGEVIEWS = spaPageviews(
  "__blumeHightouchPath",
  "htevents.page();"
);

/**
 * The loader with `key` mapped to the write key and `host` to `apiHost`;
 * everything else lands in the load options verbatim, after the mapped host
 * so a raw `apiHost` still wins.
 */
export const hightouchHead = (options: HightouchOptions): HeadScript[] => {
  const { host, key, ...load } = options;
  const loadOptions = { apiHost: host ?? HIGHTOUCH_DEFAULT_HOST, ...load };
  return [
    {
      attributes: {},
      content: `${HIGHTOUCH_LOADER}e.load(${inlineJson(key)},${inlineJson(loadOptions)}),e.page()}}();${HIGHTOUCH_SPA_PAGEVIEWS}`,
    },
  ];
};

import { z } from "zod";

import type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";
import { inlineJson } from "./inline.ts";

/** Mixpanel's data residency regions and the ingestion host each one uses. */
export const MIXPANEL_REGION_HOSTS = {
  eu: "https://api-eu.mixpanel.com",
  in: "https://api-in.mixpanel.com",
  us: "https://api.mixpanel.com",
} as const;

export type MixpanelRegion = keyof typeof MIXPANEL_REGION_HOSTS;

/** The options {@link mixpanel} maps itself. */
export interface MixpanelNamedOptions {
  /** Data residency region of the project. Defaults to US. */
  region?: MixpanelRegion;
  /** Project token. */
  token: string;
}

/**
 * Options for {@link mixpanel}: the named options plus any other
 * `mixpanel.init` option, forwarded verbatim (`persistence`, `autocapture`,
 * `record_sessions_percent`, `debug`, …). JSON values only.
 */
export type MixpanelOptions = MixpanelNamedOptions & {
  [option: string]: JsonValue;
};

export const mixpanelOptionsSchema = z
  .object({
    region: z.enum(["us", "eu", "in"]).optional(),
    token: z.string().min(1),
  })
  .catchall(z.json());

export type MixpanelAdapter = AdapterDescriptor<"mixpanel", MixpanelOptions>;

export const mixpanelAdapterSchema = adapterDescriptorSchema(
  "mixpanel",
  mixpanelOptionsSchema
);

/**
 * Mixpanel product analytics. The project token is public — it's what every
 * browser event carries.
 */
export const mixpanel = (options: MixpanelOptions): MixpanelAdapter => ({
  kind: "mixpanel",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

// The official loader snippet: a `window.mixpanel` stub that queues calls and
// injects the library.
const MIXPANEL_LOADER =
  '(function(f,b){if(!b.__SV){var e,g,i,h;window.mixpanel=b;b._i=[];b.init=function(e,f,c){function g(a,d){var b=d.split(".");2==b.length&&(a=a[b[0]],d=b[1]);a[d]=function(){a.push([d].concat(Array.prototype.slice.call(arguments,0)))}}var a=b;"undefined"!==typeof c?a=b[c]=[]:c="mixpanel";a.people=a.people||[];a.toString=function(a){var d="mixpanel";"mixpanel"!==c&&(d+="."+c);a||(d+=" (stub)");return d};a.people.toString=function(){return a.toString(1)+".people (stub)"};i="disable time_event track track_pageview track_links track_forms track_with_groups add_group set_group remove_group register register_once alias unregister identify name_tag set_config reset opt_in_tracking opt_out_tracking has_opted_in_tracking has_opted_out_tracking clear_opt_in_out_tracking start_batch_senders people.set people.set_once people.unset people.increment people.append people.union people.track_charge people.clear_charges people.delete_user people.remove".split(" ");for(h=0;h<i.length;h++)g(a,i[h]);var j="set set_once union unset remove delete".split(" ");a.get_group=function(){function b(c){d[c]=function(){call2_args=arguments;call2=[c].concat(Array.prototype.slice.call(call2_args,0));a.push([e,call2])}}for(var d={},e=["get_group"].concat(Array.prototype.slice.call(arguments,0)),c=0;c<j.length;c++)b(j[c]);return d};b._i.push([e,f,c])};b.__SV=1.2;e=f.createElement("script");e.type="text/javascript";e.async=!0;e.src="undefined"!==typeof MIXPANEL_CUSTOM_LIB_URL?MIXPANEL_CUSTOM_LIB_URL:"file:"===f.location.protocol&&"//cdn.mxpnl.com/libs/mixpanel-2-latest.min.js".match(/^\\/\\//)?"https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js":"//cdn.mxpnl.com/libs/mixpanel-2-latest.min.js";g=f.getElementsByTagName("script")[0];g.parentNode.insertBefore(e,g)}})(document,window.mixpanel||[]);';

/**
 * The init options `mixpanel()` starts from. The library counts one pageview
 * per real page load with `track_pageview: true`; this mode has it track each
 * path-or-query change too, so client-router navigations count without any
 * extra hook. A passthrough option overrides it.
 */
export const MIXPANEL_DEFAULT_INIT = {
  track_pageview: "url-with-path-and-query-string",
};

/**
 * The loader plus `mixpanel.init` with `token` mapped and `region` mapped to
 * `api_host` (the US host when unset); everything else lands in the init
 * options verbatim, after the mapped host so a raw `api_host` still wins.
 */
export const mixpanelHead = (options: MixpanelOptions): HeadScript[] => {
  const { region, token, ...init } = options;
  const initOptions = {
    ...MIXPANEL_DEFAULT_INIT,
    api_host: MIXPANEL_REGION_HOSTS[region ?? "us"],
    ...init,
  };
  return [
    {
      attributes: {},
      content: `${MIXPANEL_LOADER}mixpanel.init(${inlineJson(token)},${inlineJson(initOptions)});`,
    },
  ];
};

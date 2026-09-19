import { z } from "zod";

import type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";

/** PostHog Cloud US, the ingestion host `posthog()` uses when `host` is unset. */
export const POSTHOG_DEFAULT_HOST = "https://us.i.posthog.com";

/** The options {@link posthog} maps itself. */
export interface PosthogNamedOptions {
  /** API host (for self-hosted / EU). Defaults to PostHog Cloud US. */
  host?: string;
  /** Project API key. */
  key: string;
}

/**
 * Options for {@link posthog}: the named options plus any other `posthog.init`
 * option, forwarded verbatim (`persistence`, `capture_pageview`,
 * `autocapture`, …). JSON values only.
 */
export type PosthogOptions = PosthogNamedOptions & {
  [option: string]: JsonValue;
};

export const posthogOptionsSchema = z
  .object({
    host: z.string().optional(),
    key: z.string().min(1),
  })
  .catchall(z.json());

export type PosthogAdapter = AdapterDescriptor<"posthog", PosthogOptions>;

export const posthogAdapterSchema = adapterDescriptorSchema(
  "posthog",
  posthogOptionsSchema
);

/**
 * PostHog product analytics. The project API key is public and write-only, so
 * it is safe to ship to the browser.
 */
export const posthog = (options: PosthogOptions): PosthogAdapter => ({
  kind: "posthog",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

// The official array.js loader snippet.
const POSTHOG_LOADER =
  '!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId captureTraceFeedback captureTraceMetric".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);';

// PostHog's loader only captures a pageview per real page load, but the client
// router turns link clicks into in-place swaps — capture those too, keyed off
// `astro:page-load` with a pathname guard so the initial load (which the
// loader already counted) and same-page hash moves aren't double-counted.
const POSTHOG_SPA_PAGEVIEWS =
  'document.addEventListener("astro:page-load",function(){var p=window.__blumePhPath;window.__blumePhPath=location.pathname;if(p!==undefined&&p!==location.pathname){posthog.capture("$pageview");}});';

/**
 * The inline loader-plus-init snippet. `key` and `host` are the options Blume
 * maps (`host` becomes `api_host`); everything else lands in `posthog.init`'s
 * options verbatim, after the mapped host so a raw `api_host` still wins.
 */
export const posthogHead = (options: PosthogOptions): HeadScript => {
  const { host, key, ...init } = options;
  const initOptions = { api_host: host ?? POSTHOG_DEFAULT_HOST, ...init };
  return {
    attributes: {},
    content: `${POSTHOG_LOADER}posthog.init(${JSON.stringify(key)},${JSON.stringify(initOptions)});${POSTHOG_SPA_PAGEVIEWS}`,
  };
};

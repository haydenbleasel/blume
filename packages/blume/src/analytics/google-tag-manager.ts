import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";
import { inlineJson } from "./inline.ts";

/** Options for {@link googleTagManager}. */
export interface GoogleTagManagerOptions {
  /** Name of the data layer global the container reads. Defaults to `dataLayer`. */
  dataLayer?: string;
  /** Container ID (`GTM-…`). */
  id: string;
}

export const googleTagManagerOptionsSchema = z.strictObject({
  dataLayer: z.string().min(1).optional(),
  id: z.string().min(1),
});

export type GoogleTagManagerAdapter = AdapterDescriptor<
  "google-tag-manager",
  GoogleTagManagerOptions
>;

export const googleTagManagerAdapterSchema = adapterDescriptorSchema(
  "google-tag-manager",
  googleTagManagerOptionsSchema
);

/**
 * Google Tag Manager. Blume loads the container; which tags fire, and on what,
 * is the container's configuration. The container ID is public.
 */
export const googleTagManager = (
  options: GoogleTagManagerOptions
): GoogleTagManagerAdapter => ({
  kind: "google-tag-manager",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

/**
 * The container snippet from the workspace's install instructions (the
 * `<head>` half; the `<noscript>` iframe is for browsers without JavaScript,
 * which never run analytics anyway). Client-router navigations reach the
 * container as history changes — fire pageview tags from a History Change
 * trigger rather than the page-load one.
 */
export const googleTagManagerHead = (
  options: GoogleTagManagerOptions
): HeadScript[] => [
  {
    attributes: {},
    content: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({"gtm.start":new Date().getTime(),event:"gtm.js"});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!="dataLayer"?"&l="+l:"";j.async=true;j.src="https://www.googletagmanager.com/gtm.js?id="+i+dl;f.parentNode.insertBefore(j,f);})(window,document,"script",${inlineJson(options.dataLayer ?? "dataLayer")},${inlineJson(encodeURIComponent(options.id))});`,
  },
];

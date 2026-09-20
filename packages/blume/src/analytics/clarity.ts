import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";
import { inlineJson } from "./inline.ts";

/** Options for {@link clarity}. */
export interface ClarityOptions {
  /** Project ID, from the project's tracking code in the Clarity dashboard. */
  id: string;
}

export const clarityOptionsSchema = z.strictObject({
  id: z.string().min(1),
});

export type ClarityAdapter = AdapterDescriptor<"clarity", ClarityOptions>;

export const clarityAdapterSchema = adapterDescriptorSchema(
  "clarity",
  clarityOptionsSchema
);

/**
 * Microsoft Clarity session recordings and heatmaps. The project ID is public;
 * it only picks the project the tag reports to.
 */
export const clarity = (options: ClarityOptions): ClarityAdapter => ({
  kind: "clarity",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

/**
 * The dashboard's tracking code: a `window.clarity` queue and the async tag
 * load. Clarity follows history changes itself, so client-router navigations
 * need no extra hook.
 */
export const clarityHead = (options: ClarityOptions): HeadScript[] => [
  {
    attributes: {},
    content: `(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script",${inlineJson(encodeURIComponent(options.id))});`,
  },
];

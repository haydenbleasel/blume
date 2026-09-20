import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";

/** The tracking-code version (`hjsv`) `hotjar()` uses when `version` is unset. */
export const HOTJAR_DEFAULT_VERSION = 6;

/** Options for {@link hotjar}. */
export interface HotjarOptions {
  /** Site ID (`hjid`), from the site's tracking code. */
  id: number;
  /** Tracking-code version (`hjsv`). Defaults to the current one. */
  version?: number;
}

export const hotjarOptionsSchema = z.strictObject({
  id: z.number().int().positive(),
  version: z.number().int().positive().optional(),
});

export type HotjarAdapter = AdapterDescriptor<"hotjar", HotjarOptions>;

export const hotjarAdapterSchema = adapterDescriptorSchema(
  "hotjar",
  hotjarOptionsSchema
);

/**
 * Hotjar heatmaps and recordings. The site ID is public — it's in the tracking
 * code on every page.
 */
export const hotjar = (options: HotjarOptions): HotjarAdapter => ({
  kind: "hotjar",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

/** The tracking code as the site's install instructions render it. */
export const hotjarHead = (options: HotjarOptions): HeadScript[] => [
  {
    attributes: {},
    content: `(function(h,o,t,j,a,r){h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};h._hjSettings={hjid:${options.id},hjsv:${options.version ?? HOTJAR_DEFAULT_VERSION}};a=o.getElementsByTagName("head")[0];r=o.createElement("script");r.async=1;r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv;a.appendChild(r);})(window,document,"https://static.hotjar.com/c/hotjar-",".js?sv=");`,
  },
];

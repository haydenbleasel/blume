import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";

/** Options for {@link clearbit}. */
export interface ClearbitOptions {
  /** Publishable API key (`pk_…`). */
  key: string;
}

export const clearbitOptionsSchema = z.strictObject({
  key: z.string().min(1),
});

export type ClearbitAdapter = AdapterDescriptor<"clearbit", ClearbitOptions>;

export const clearbitAdapterSchema = adapterDescriptorSchema(
  "clearbit",
  clearbitOptionsSchema
);

/**
 * Clearbit's website tag (Reveal and the Clearbit tags it manages). The
 * publishable key is meant for the browser.
 */
export const clearbit = (options: ClearbitOptions): ClearbitAdapter => ({
  kind: "clearbit",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

/** The tag origin; the key picks the tags bundle. */
export const CLEARBIT_TAG_ORIGIN = "https://tag.clearbitscripts.com/v1/";

/** The tag as Clearbit's install snippet renders it. */
export const clearbitHead = (options: ClearbitOptions): HeadScript[] => [
  {
    attributes: {
      referrerpolicy: "strict-origin-when-cross-origin",
      src: `${CLEARBIT_TAG_ORIGIN}${encodeURIComponent(options.key)}/tags.js`,
    },
    content: null,
  },
];

import { notraScript } from "@usenotra/sdk/script";
import type { NotraScriptOptions } from "@usenotra/sdk/script";
import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";

/** The prefix every public Notra web key starts with. */
export const NOTRA_WEB_KEY_PREFIX = "nwk.";

/**
 * Options for {@link notra}: the `@usenotra/sdk/script` options. Only
 * `webKey` is required; the rest pick the build (`errors`), count `#hash`
 * routes (`hash`), or point the script and its beacon at a self-hosted ingest
 * or proxy (`endpoint`, `api`, `src`, `integrity`, `pinned`).
 */
export type NotraOptions = NotraScriptOptions;

export const notraOptionsSchema = z.strictObject({
  api: z.string().min(1).optional(),
  endpoint: z.string().min(1).optional(),
  errors: z.boolean().optional(),
  hash: z.boolean().optional(),
  integrity: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
  src: z.string().min(1).optional(),
  webKey: z.string().startsWith(NOTRA_WEB_KEY_PREFIX, {
    error: `Notra's webKey is the public web key from Settings → Tracking in Notra, and starts with "${NOTRA_WEB_KEY_PREFIX}".`,
  }),
});

export type NotraAdapter = AdapterDescriptor<"notra", NotraOptions>;

export const notraAdapterSchema = adapterDescriptorSchema(
  "notra",
  notraOptionsSchema
);

/**
 * Notra web analytics (notra.js). The web key is public — it's in the tag on
 * every page.
 */
export const notra = (options: NotraOptions): NotraAdapter => ({
  kind: "notra",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

/**
 * The deferred tag `@usenotra/sdk` writes: the notra.js build that SDK release
 * pins, with its integrity hash, `data-key`, and the beacon endpoint. notra.js
 * patches `history.pushState` itself, so client-router navigations need no
 * extra hook, and it has no custom-event API for Blume's events to reach.
 */
export const notraHead = (options: NotraOptions): HeadScript[] => {
  const { crossOrigin, "data-hash": hash, ...rest } = notraScript(options);
  const attributes: HeadScript["attributes"] = {};
  for (const [name, value] of Object.entries(rest)) {
    if (value !== undefined) {
      attributes[name] = value;
    }
  }
  if (hash !== undefined) {
    attributes["data-hash"] = true;
  }
  if (crossOrigin !== undefined) {
    attributes.crossorigin = crossOrigin;
  }
  return [{ attributes, content: null }];
};

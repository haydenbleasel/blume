import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import { normalizeBasePath, withBasePath } from "../core/base-path.ts";
import { trimEnd } from "../core/trim.ts";
import type { HeadScript } from "./head.ts";

/** The prefix every public Notra web key starts with. */
export const NOTRA_WEB_KEY_PREFIX = "nwk.";

/** Notra's script host, where notra.js loads from without `endpoint` or `src`. */
export const NOTRA_SCRIPT_ORIGIN = "https://static.usenotra.com";

/** Notra's ingest, where page views go when Notra's script host serves the script. */
export const NOTRA_COLLECT_URL = "https://ingest.usenotra.com/api/collect";

/** One notra.js build: its file name and its Subresource Integrity hash. */
export interface NotraScriptRelease {
  /** `notra.<build>.js` or `notra.plus.<build>.js`. */
  file: string;
  /** Subresource Integrity value, `sha384-<base64>`. */
  integrity: string;
}

/**
 * The notra.js build this Blume release pins: the one `@usenotra/sdk` pins.
 * The SDK is a devDependency only, so a site installs nothing for a provider
 * it doesn't use; `test/analytics-providers.test.ts` fails when an SDK update
 * moves the pin, which is the prompt to copy the new values here.
 */
export const NOTRA_SCRIPT_RELEASE: NotraScriptRelease = {
  file: "notra.ce3c872ef9c9.js",
  integrity:
    "sha384-LuUp5Hj+rSQ4/mZp1sWBOrJDHIHKGqflwF1GYIreqmWdCaI1otOQealWJGRj6Toj",
};

/** The pinned `notra.plus.js` build, which also reports JavaScript errors. */
export const NOTRA_SCRIPT_PLUS_RELEASE: NotraScriptRelease = {
  file: "notra.plus.d703b9cc5508.js",
  integrity:
    "sha384-MgLdHKufD0WdkO4pxtkT/bbNCKxl6PxOyUJe+M/qwFGfjOdZ5rEnljxTlOVQIzF+",
};

/**
 * Options for {@link notra}, named as `@usenotra/sdk/script` names them. Only
 * `webKey` is required; the rest pick the build (`errors`, `pinned`), count
 * `#fragment` changes (`hash`), or point the script and its beacon at a
 * self-hosted ingest or proxy (`endpoint`, `api`, `src`, `integrity`).
 */
export interface NotraOptions {
  /** Public web key (`nwk.…`), from Settings → Tracking in Notra. */
  webKey: string;
  /**
   * Beacon endpoint (`data-api`). Defaults to Notra's ingest, or — with
   * `endpoint` or `src` — to `/api/collect` on the script's own origin.
   */
  api?: string;
  /**
   * Origin of a self-hosted ingest or proxy that serves the script under
   * `/api/` and takes page views at `/api/collect`.
   */
  endpoint?: string;
  /** Load `notra.plus.js`, which also reports JavaScript errors. */
  errors?: boolean;
  /**
   * Count every `#fragment` change as a page view. Blume has no hash routes,
   * so this counts each table-of-contents click, tab switch, and opened
   * accordion.
   */
  hash?: boolean;
  /** Subresource Integrity value (`sha384-…`), overriding the pinned build's. */
  integrity?: string;
  /** Load the pinned build with its integrity hash. Defaults to `true`. */
  pinned?: boolean;
  /**
   * Full script URL, for self-hosting. Overrides `endpoint`, `errors`, and
   * `pinned`. A root-relative one is a file in `public/`.
   */
  src?: string;
}

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
 * Which script the tag loads, and the integrity hash it's checked against. An
 * explicit `src` wins; a root-relative one (a file in `public/`) is served
 * under the deployment `base`, the way a `script()` adapter's is. Otherwise
 * the file sits at the root of Notra's script host, or under `/api/` on an
 * `endpoint`, and is the pinned build unless `pinned` is off.
 */
const notraSource = (options: NotraOptions, base: string) => {
  if (options.src) {
    return {
      integrity: options.integrity,
      src: withBasePath(normalizeBasePath(base), options.src),
    };
  }
  const directory = options.endpoint
    ? `${trimEnd(options.endpoint, "/")}/api/`
    : `${NOTRA_SCRIPT_ORIGIN}/`;
  if (options.pinned === false) {
    return {
      integrity: options.integrity,
      src: `${directory}${options.errors ? "notra.plus.js" : "notra.js"}`,
    };
  }
  const release = options.errors
    ? NOTRA_SCRIPT_PLUS_RELEASE
    : NOTRA_SCRIPT_RELEASE;
  return {
    integrity: options.integrity ?? release.integrity,
    src: `${directory}${release.file}`,
  };
};

/**
 * The deferred tag `@usenotra/sdk`'s `notraScript()` writes, built from the
 * constants above: the pinned notra.js build with its integrity hash,
 * `data-key`, and the beacon endpoint. With `endpoint` or `src` and no `api`,
 * the tag carries no `data-api`, and notra.js posts to `/api/collect` on the
 * origin its script came from. notra.js patches `history.pushState` itself, so
 * client-router navigations need no extra hook, and it has no custom-event API
 * for Blume's events to reach.
 */
export const notraHead = (
  options: NotraOptions,
  base: string
): HeadScript[] => {
  const { integrity, src } = notraSource(options, base);
  const attributes: HeadScript["attributes"] = {
    "data-key": options.webKey,
    defer: true,
    src,
  };
  const api =
    options.api ?? (options.endpoint || options.src ? null : NOTRA_COLLECT_URL);
  if (api) {
    attributes["data-api"] = api;
  }
  if (options.hash) {
    attributes["data-hash"] = true;
  }
  if (integrity) {
    attributes.crossorigin = "anonymous";
    attributes.integrity = integrity;
  }
  return [{ attributes, content: null }];
};

import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import { rateLimitOptionsSchema } from "./memory.ts";
import type { RateLimitOptions } from "./memory.ts";

/** The env var holding the Unkey root key, unless set. */
const UNKEY_ROOT_KEY_ENV = "UNKEY_ROOT_KEY";

/** The Unkey rate limit namespace the count is kept in, unless set. */
export const UNKEY_NAMESPACE = "docs";

/** The longest window Unkey takes, in seconds (30 days). */
export const UNKEY_MAX_WINDOW = 2_592_000;

/** Options for {@link unkey}. */
export interface UnkeyOptions extends RateLimitOptions {
  /**
   * The Unkey rate limit namespace, up to 512 characters. Defaults to `docs`;
   * Unkey creates it on the first request.
   */
  namespace?: string;
  /** Name of the env var holding the root key. Defaults to `UNKEY_ROOT_KEY`. */
  rootKeyEnv?: string;
  /** The window, in seconds: Unkey takes up to 30 days. */
  window?: number;
}

export const unkeyOptionsSchema = rateLimitOptionsSchema.extend({
  namespace: z.string().min(1).max(512).optional(),
  rootKeyEnv: z.string().min(1).optional(),
  window: z.number().int().positive().max(UNKEY_MAX_WINDOW).optional(),
});

export type UnkeyAdapter = AdapterDescriptor<"unkey", UnkeyOptions>;

export const unkeyAdapterSchema = adapterDescriptorSchema(
  "unkey",
  unkeyOptionsSchema
);

/** The env var the root key is read from. */
export const unkeySecrets = (options: UnkeyOptions): [string] => [
  options.rootKeyEnv ?? UNKEY_ROOT_KEY_ENV,
];

/**
 * Counts with Unkey's rate limiting, which every instance on every host
 * shares. Unkey counts in each region and shares the counts between them
 * within moments, so a short burst split across regions can pass more than
 * the limit. It talks to Unkey's REST API, so there is nothing to install;
 * the root key comes from `UNKEY_ROOT_KEY`, or the env var `rootKeyEnv`
 * names.
 */
export const unkey = (options: UnkeyOptions = {}): UnkeyAdapter => ({
  kind: "unkey",
  options,
  requiredSecrets: unkeySecrets(options),
  runtimeDeps: [],
});

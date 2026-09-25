import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";

/** The script OneDollarStats' install snippet loads. */
export const ONE_DOLLAR_STATS_SCRIPT_SRC =
  "https://assets.onedollarstats.com/stonks.js";

/** The options {@link oneDollarStats} checks itself. */
export interface OneDollarStatsNamedOptions {
  /**
   * A bare host name, e.g. `docs.example.com`. The tracker reports every
   * event under it on every host, not just `localhost`.
   */
  hostname?: string;
}

/**
 * Options for {@link oneDollarStats}: any tracker setting, forwarded as a
 * `data-` attribute on the tag (`hostname` → `data-hostname`, `devmode`,
 * `url`, `autocollect`, `"hash-routing"`, …).
 */
export type OneDollarStatsOptions = OneDollarStatsNamedOptions & {
  [setting: string]: string;
};

export const oneDollarStatsOptionsSchema = z
  .object({
    hostname: z
      .string()
      .regex(/^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*(?::\d+)?$/u, {
        message:
          "`hostname` must be a bare host name like `docs.example.com`, without `https://`, a path, a query, or a fragment.",
      })
      .optional(),
  })
  .catchall(z.string());

export type OneDollarStatsAdapter = AdapterDescriptor<
  "one-dollar-stats",
  OneDollarStatsOptions
>;

export const oneDollarStatsAdapterSchema = adapterDescriptorSchema(
  "one-dollar-stats",
  oneDollarStatsOptionsSchema
);

/**
 * OneDollarStats. Needs no keys — the dashboard matches events to a site by
 * the domain they come from.
 */
export const oneDollarStats = (
  options: OneDollarStatsOptions = {}
): OneDollarStatsAdapter => ({
  kind: "one-dollar-stats",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

/**
 * The deferred tag from the install instructions, with every option as its
 * own `data-` attribute. The tracker reads them from `document.currentScript`,
 * so the tag stays a classic external script. It hooks `pushState` and
 * `popstate` itself, so client-router navigations need no extra hook.
 *
 * The tracker turns hash routing on whenever `data-hash-routing` is present,
 * whatever its value, so `"hash-routing": "false"` leaves the attribute off.
 */
export const oneDollarStatsHead = (
  options: OneDollarStatsOptions
): HeadScript[] => {
  const attributes: HeadScript["attributes"] = {};
  for (const [setting, value] of Object.entries(options)) {
    if (setting === "hash-routing" && value === "false") {
      continue;
    }
    attributes[`data-${setting}`] = value;
  }
  attributes.defer = true;
  attributes.src = ONE_DOLLAR_STATS_SCRIPT_SRC;
  return [{ attributes, content: null }];
};

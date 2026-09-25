import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";

/** The script OneDollarStats' install snippet loads. */
export const ONE_DOLLAR_STATS_SCRIPT_SRC =
  "https://assets.onedollarstats.com/stonks.js";

/**
 * Options for {@link oneDollarStats}: any tracker setting, forwarded as a
 * `data-` attribute on the tag (`hostname` → `data-hostname`, `devmode`,
 * `url`, `autocollect`, `"hash-routing"`, …).
 */
export interface OneDollarStatsOptions {
  [setting: string]: string;
}

export const oneDollarStatsOptionsSchema = z.object({}).catchall(z.string());

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
 */
export const oneDollarStatsHead = (
  options: OneDollarStatsOptions
): HeadScript[] => {
  const attributes: HeadScript["attributes"] = {};
  for (const [setting, value] of Object.entries(options)) {
    attributes[`data-${setting}`] = value;
  }
  attributes.defer = true;
  attributes.src = ONE_DOLLAR_STATS_SCRIPT_SRC;
  return [{ attributes, content: null }];
};

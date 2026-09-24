import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";

/** The script Databuddy's install snippet loads. */
export const DATABUDDY_SCRIPT_SRC = "https://cdn.databuddy.cc/databuddy.js";

/** The options {@link databuddy} maps itself. */
export interface DatabuddyNamedOptions {
  /** Client ID, from the website's settings in the Databuddy dashboard. */
  clientId: string;
}

/**
 * Options for {@link databuddy}: the client ID plus any other tracker setting,
 * forwarded as a `data-` attribute on the tag (`"track-web-vitals"` →
 * `data-track-web-vitals`, `"track-errors"`, `"track-outgoing-links"`,
 * `"api-url"`, …).
 */
export type DatabuddyOptions = DatabuddyNamedOptions & {
  [setting: string]: string;
};

export const databuddyOptionsSchema = z
  .object({
    clientId: z.string().min(1),
  })
  .catchall(z.string());

export type DatabuddyAdapter = AdapterDescriptor<"databuddy", DatabuddyOptions>;

export const databuddyAdapterSchema = adapterDescriptorSchema(
  "databuddy",
  databuddyOptionsSchema
);

/**
 * Databuddy. The client ID is public — it's in the tag on every page.
 */
export const databuddy = (options: DatabuddyOptions): DatabuddyAdapter => ({
  kind: "databuddy",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

/**
 * The async tag from the install instructions, with `clientId` as
 * `data-client-id` and every other option as its own `data-` attribute. The
 * tracker skips setup when `window.databuddy` already exists, so there is no
 * queue stub. Databuddy's script tracks history changes on its own, so
 * client-router navigations need no extra hook.
 */
export const databuddyHead = (options: DatabuddyOptions): HeadScript[] => {
  const { clientId, ...settings } = options;
  const attributes: HeadScript["attributes"] = {};
  for (const [setting, value] of Object.entries(settings)) {
    attributes[`data-${setting}`] = value;
  }
  attributes["data-client-id"] = clientId;
  attributes.async = true;
  attributes.crossorigin = "anonymous";
  attributes.src = DATABUDDY_SCRIPT_SRC;
  return [{ attributes, content: null }];
};

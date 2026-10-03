import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";

/** The browser tracker in Clics' installation guide. */
export const CLICS_SCRIPT_SRC = "https://clics.dev/tracker.js";

/** Public project ID and optional tracker flags. */
export interface ClicsOptions {
  /** Project ID from Configure → Tracking in the Clics dashboard. */
  projectId: string;
  /** Include localhost and 127.0.0.1 in a production build's reports. */
  allowLocalhost?: boolean;
  /** Turn off automatic outbound-link events. */
  disableOutboundLinks?: boolean;
}

export const clicsOptionsSchema = z.strictObject({
  allowLocalhost: z.boolean().optional(),
  disableOutboundLinks: z.boolean().optional(),
  projectId: z.string().min(1),
});

export type ClicsAdapter = AdapterDescriptor<"clics", ClicsOptions>;

export const clicsAdapterSchema = adapterDescriptorSchema(
  "clics",
  clicsOptionsSchema
);

/** Clics website analytics. The project ID is public in the tracker tag. */
export const clics = (options: ClicsOptions): ClicsAdapter => ({
  kind: "clics",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

/**
 * The documented deferred tracker tag. Clics reads these attributes from
 * `document.currentScript` and tracks history changes without a Blume hook.
 */
export const clicsHead = (options: ClicsOptions): HeadScript[] => {
  const attributes: HeadScript["attributes"] = {
    "data-project-id": options.projectId,
    defer: true,
    src: CLICS_SCRIPT_SRC,
  };
  if (options.allowLocalhost) {
    attributes["data-allow-localhost"] = true;
  }
  if (options.disableOutboundLinks) {
    attributes["data-disable-outbound-links"] = true;
  }
  return [{ attributes, content: null }];
};

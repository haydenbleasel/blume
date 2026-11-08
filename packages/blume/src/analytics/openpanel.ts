import { z } from "zod";

import type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";
import { inlineJson } from "./inline.ts";

/** OpenPanel Cloud's tracker, the script `openpanel()` loads when `scriptUrl` is unset. */
export const OPENPANEL_SCRIPT_SRC = "https://openpanel.dev/op1.js";

/** The options {@link openpanel} maps itself. */
export interface OpenpanelNamedOptions {
  /** Client ID, from the project's settings in the OpenPanel dashboard. */
  clientId: string;
  /** Tracker script URL (for a proxy or self-hosted instance). Defaults to OpenPanel Cloud. */
  scriptUrl?: string;
}

/**
 * Options for {@link openpanel}: the named options plus any other
 * `window.op("init")` option, forwarded verbatim (`apiUrl`,
 * `trackHashChanges`, `sessionReplay`, …). JSON values only.
 */
export type OpenpanelOptions = OpenpanelNamedOptions & {
  [option: string]: JsonValue;
};

export const openpanelOptionsSchema = z
  .object({
    clientId: z.string().min(1),
    scriptUrl: z.string().min(1).optional(),
  })
  .catchall(z.json());

export type OpenpanelAdapter = AdapterDescriptor<"openpanel", OpenpanelOptions>;

export const openpanelAdapterSchema = adapterDescriptorSchema(
  "openpanel",
  openpanelOptionsSchema
);

/**
 * OpenPanel web and product analytics. The client ID is public — it's in the
 * init call on every page.
 */
export const openpanel = (options: OpenpanelOptions): OpenpanelAdapter => ({
  kind: "openpanel",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

/**
 * The init options the install snippet ships with. The tracker only turns
 * each one on when it is `true`, so leaving them unset would track nothing
 * automatically; a passthrough option overrides any of them.
 */
export const OPENPANEL_DEFAULT_INIT = {
  trackAttributes: true,
  trackOutgoingLinks: true,
  trackScreenViews: true,
};

// The official queue stub: `window.op(...)` calls made before the tracker
// lands are kept on `op.q`, which the tracker replays (init first) on load.
const OPENPANEL_STUB =
  'window.op=window.op||function(){var n=[];return new Proxy(function(){arguments.length&&n.push([].slice.call(arguments))},{get:function(t,r){return"q"===r?n:function(){n.push([r].concat([].slice.call(arguments)))}},has:function(t,r){return"q"===r}})}();';

/**
 * The two tags from the install snippet: the queue stub plus the init call,
 * then the tracker. `clientId` is mapped and everything else lands in the
 * init options verbatim. With `trackScreenViews` on, the tracker wraps
 * `pushState` and listens for `popstate` itself, so client-router
 * navigations need no extra hook.
 */
export const openpanelHead = (options: OpenpanelOptions): HeadScript[] => {
  const { clientId, scriptUrl, ...init } = options;
  const initOptions = { clientId, ...OPENPANEL_DEFAULT_INIT, ...init };
  return [
    {
      attributes: {},
      content: `${OPENPANEL_STUB}window.op("init",${inlineJson(initOptions)});`,
    },
    {
      attributes: {
        async: true,
        defer: true,
        src: scriptUrl ?? OPENPANEL_SCRIPT_SRC,
      },
      content: null,
    },
  ];
};

import { z } from "zod";

import type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";
import { inlineJson } from "./inline.ts";

/** The options {@link amplitude} maps itself. */
export interface AmplitudeNamedOptions {
  /** Project API key. */
  key: string;
}

/**
 * Options for {@link amplitude}: the key plus any other Browser SDK
 * `amplitude.init` option, forwarded verbatim (`serverZone`, `autocapture`,
 * `defaultTracking`, …). JSON values only.
 */
export type AmplitudeOptions = AmplitudeNamedOptions & {
  [option: string]: JsonValue;
};

export const amplitudeOptionsSchema = z
  .object({
    key: z.string().min(1),
  })
  .catchall(z.json());

export type AmplitudeAdapter = AdapterDescriptor<"amplitude", AmplitudeOptions>;

export const amplitudeAdapterSchema = adapterDescriptorSchema(
  "amplitude",
  amplitudeOptionsSchema
);

/**
 * Amplitude product analytics through the Browser SDK's script loader. The
 * project API key is public — it's what every browser event carries.
 */
export const amplitude = (options: AmplitudeOptions): AmplitudeAdapter => ({
  kind: "amplitude",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

/** The script loader's CDN; the key picks the bundle. */
export const AMPLITUDE_SCRIPT_ORIGIN = "https://cdn.amplitude.com/script/";

/**
 * The init options the dashboard snippet ships with. `autocapture` covers page
 * views, sessions, and history changes, so client-router navigations count
 * without any extra hook; a passthrough option overrides either.
 */
export const AMPLITUDE_DEFAULT_INIT = {
  autocapture: true,
  fetchRemoteConfig: true,
};

/**
 * The two tags from the dashboard's install snippet: the keyed SDK bundle
 * (synchronous, so `window.amplitude` exists for the next tag) and the init
 * call, with `key` mapped and everything else forwarded to `init` verbatim.
 */
export const amplitudeHead = (options: AmplitudeOptions): HeadScript[] => {
  const { key, ...init } = options;
  return [
    {
      attributes: {
        src: `${AMPLITUDE_SCRIPT_ORIGIN}${encodeURIComponent(key)}.js`,
      },
      content: null,
    },
    {
      attributes: {},
      content: `window.amplitude.init(${inlineJson(key)},${inlineJson({ ...AMPLITUDE_DEFAULT_INIT, ...init })});`,
    },
  ];
};

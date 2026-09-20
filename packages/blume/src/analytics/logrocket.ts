import { z } from "zod";

import type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";
import { inlineJson } from "./inline.ts";

/** The SDK script LogRocket's install snippet loads. */
export const LOGROCKET_SCRIPT_SRC = "https://cdn.logrocket.io/LogRocket.min.js";

/** The options {@link logrocket} maps itself. */
export interface LogrocketNamedOptions {
  /** App ID (`org/app`), from the project's settings. */
  id: string;
}

/**
 * Options for {@link logrocket}: the app ID plus any other `LogRocket.init`
 * option, forwarded verbatim (`release`, `console`, `network`, `dom`, …). JSON
 * values only; a sanitizer function can't travel through config — call
 * `LogRocket.init` yourself from a `script()` adapter for those.
 */
export type LogrocketOptions = LogrocketNamedOptions & {
  [option: string]: JsonValue;
};

export const logrocketOptionsSchema = z
  .object({
    id: z.string().min(1),
  })
  .catchall(z.json());

export type LogrocketAdapter = AdapterDescriptor<"logrocket", LogrocketOptions>;

export const logrocketAdapterSchema = adapterDescriptorSchema(
  "logrocket",
  logrocketOptionsSchema
);

/**
 * LogRocket session replay. The app ID is public — it's what the SDK reports
 * under.
 */
export const logrocket = (options: LogrocketOptions): LogrocketAdapter => ({
  kind: "logrocket",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

/**
 * The two tags from the install snippet: the SDK (synchronous, so
 * `window.LogRocket` exists for the next tag) and the guarded `init` call,
 * with `id` mapped and everything else forwarded to `init` verbatim; the
 * options object is left off when there is nothing to pass, as the snippet
 * prints it. A session spans client-router navigations on its own.
 */
export const logrocketHead = (options: LogrocketOptions): HeadScript[] => {
  const { id, ...init } = options;
  const call =
    Object.keys(init).length === 0
      ? `window.LogRocket.init(${inlineJson(id)})`
      : `window.LogRocket.init(${inlineJson(id)},${inlineJson(init)})`;
  return [
    {
      attributes: { crossorigin: "anonymous", src: LOGROCKET_SCRIPT_SRC },
      content: null,
    },
    { attributes: {}, content: `window.LogRocket&&${call};` },
  ];
};

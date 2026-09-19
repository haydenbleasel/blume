import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";

/** Options for {@link script}; set exactly one of `src` or `content`. */
export interface ScriptOptions {
  /** Extra attributes spread onto the `<script>` (e.g. `data-domain`, `id`). */
  attributes?: Record<string, string>;
  /** Inline script body. Mutually exclusive with `src`. */
  content?: string;
  /** External script URL. Mutually exclusive with `content`. */
  src?: string;
  /** Load strategy for an external script. */
  strategy?: "async" | "defer";
}

export const scriptOptionsSchema = z
  .strictObject({
    attributes: z.record(z.string(), z.string()).optional(),
    content: z.string().optional(),
    src: z.string().optional(),
    strategy: z.enum(["async", "defer"]).optional(),
  })
  .refine((value) => Boolean(value.src) !== Boolean(value.content), {
    message: "An analytics script must set exactly one of `src` or `content`.",
  });

export type ScriptAdapter = AdapterDescriptor<"script", ScriptOptions>;

export const scriptAdapterSchema = adapterDescriptorSchema(
  "script",
  scriptOptionsSchema
);

/**
 * Any other provider (Plausible, Fathom, GA, Umami, …) as one `<script>` tag:
 * external via `src`, inline via `content`. `attributes` is the verbatim
 * passthrough here — every entry lands on the tag as-is.
 */
export const script = (options: ScriptOptions): ScriptAdapter => ({
  kind: "script",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

/** The tag. Explicit `src`/`strategy` win over a same-named spread attribute. */
export const scriptHead = (options: ScriptOptions): HeadScript => {
  const attributes: HeadScript["attributes"] = { ...options.attributes };
  if (!options.src) {
    return { attributes, content: options.content ?? "" };
  }
  if (options.strategy) {
    attributes[options.strategy] = true;
  }
  attributes.src = options.src;
  return { attributes, content: null };
};

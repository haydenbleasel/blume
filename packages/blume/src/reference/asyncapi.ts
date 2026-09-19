import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import {
  liftSpec,
  referenceSourceSchema,
  hasSources,
  missingSourcesIssue,
  sharedOptions,
} from "./options.ts";
import type { PlaygroundOptions, ReferenceSourceOptions } from "./options.ts";
import { rendererRuntimeDeps, scalarRendererSchema } from "./scalar.ts";
import type { ScalarRenderer } from "./scalar.ts";

/** Options for {@link asyncapi}. */
export interface AsyncApiOptions {
  /**
   * Code-sample tools shown per operation (Blume renderer). Defaults to every
   * tool appropriate to the operation's protocol binding.
   */
  codeSamples?: string[];
  /** Start nested schema rows expanded rather than collapsed (Blume renderer). Defaults to `false`. */
  expandSchemas?: boolean;
  /**
   * The "Try it" message composer (Blume renderer). On by default; `false`
   * hides it. `proxy` is accepted for parity but doesn't apply to event
   * operations — a WebSocket connect goes straight from the browser.
   */
  playground?: PlaygroundOptions;
  /** Who renders the reference: unset for Blume's own UI, or `scalar()` for the embedded Scalar SPA. */
  renderer?: ScalarRenderer;
  /** Where the reference mounts. Defaults to `/events`. */
  route?: string;
  /** One or more specs; each renders on its own route by default. */
  sources?: ReferenceSourceOptions[];
  /** Shorthand for a single source: `sources: [{ spec }]`. */
  spec?: string;
}

export const asyncapiOptionsSchema = z
  .strictObject({
    // Empty `codeSamples` means every tool the operation's protocol binding
    // suggests.
    ...sharedOptions({ codeSamples: [], route: "/events" }),
    /** Start nested schema rows expanded rather than collapsed (Blume renderer). */
    expandSchemas: z.boolean().default(false),
    /** The embedded Scalar SPA, when opted into; unset means Blume's own UI. */
    renderer: scalarRendererSchema.optional(),
    /** One or more specs; each renders on its own route by default. */
    sources: z.array(referenceSourceSchema).default([]),
  })
  .transform(liftSpec(referenceSourceSchema))
  .refine(hasSources, missingSourcesIssue("asyncapi"));

/** `asyncapi()` options with every default applied and `spec` folded into `sources`. */
export type ResolvedAsyncApiOptions = z.output<typeof asyncapiOptionsSchema>;

export type AsyncApiAdapter = AdapterDescriptor<"asyncapi", AsyncApiOptions>;

/** An `asyncapi()` descriptor as the config schema resolves it. */
export type ResolvedAsyncApiAdapter = AdapterDescriptor<
  "asyncapi",
  ResolvedAsyncApiOptions
>;

export const asyncapiAdapterSchema = adapterDescriptorSchema(
  "asyncapi",
  asyncapiOptionsSchema
);

/**
 * An AsyncAPI reference. By default Blume normalizes the spec to AsyncAPI 3.x
 * and renders its own UI — one real page per operation, in the sidebar,
 * search, llms.txt, and OG — with `renderer: scalar()` as the embedded-SPA
 * opt-out. Only the defaults differ from `openapi()`: the reference mounts at
 * `/events`, and empty `codeSamples` means every tool the operation's protocol
 * binding suggests.
 */
export const asyncapi = (options: AsyncApiOptions): AsyncApiAdapter => ({
  kind: "asyncapi",
  options,
  requiredSecrets: [],
  runtimeDeps: rendererRuntimeDeps(options.renderer),
});

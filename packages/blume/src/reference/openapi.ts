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

/** Options for {@link openapi}. */
export interface OpenApiOptions {
  /** Code-sample languages shown per operation (Blume renderer). Defaults to `["curl", "js", "python"]`. */
  codeSamples?: string[];
  /** Start nested schema rows expanded rather than collapsed (Blume renderer). Defaults to `false`. */
  expandSchemas?: boolean;
  /**
   * The interactive "Try it" panel (Blume renderer). On by default; `false`
   * hides it. The object form sets `proxy`, the CORS escape hatch the Send
   * button routes requests through: a proxy URL, or `true` for the built-in
   * `/_api-proxy` endpoint (which requires `deployment.output: "server"`).
   */
  playground?: PlaygroundOptions;
  /** Who renders the reference: unset for Blume's own UI, or `scalar()` for the embedded Scalar SPA. */
  renderer?: ScalarRenderer;
  /** Where the reference mounts. Defaults to `/reference`. */
  route?: string;
  /** One or more specs; each renders on its own route by default. */
  sources?: ReferenceSourceOptions[];
  /** Shorthand for a single source: `sources: [{ spec }]`. */
  spec?: string;
}

export const openapiOptionsSchema = z
  .strictObject({
    ...sharedOptions({
      codeSamples: ["curl", "js", "python"],
      route: "/reference",
    }),
    /** Start nested schema rows expanded rather than collapsed (Blume renderer). */
    expandSchemas: z.boolean().default(false),
    /** The embedded Scalar SPA, when opted into; unset means Blume's own UI. */
    renderer: scalarRendererSchema.optional(),
    /** One or more specs; each renders on its own route by default. */
    sources: z.array(referenceSourceSchema).default([]),
  })
  .transform(liftSpec(referenceSourceSchema))
  .refine(hasSources, missingSourcesIssue("openapi"));

/** `openapi()` options with every default applied and `spec` folded into `sources`. */
export type ResolvedOpenApiOptions = z.output<typeof openapiOptionsSchema>;

export type OpenApiAdapter = AdapterDescriptor<"openapi", OpenApiOptions>;

/** An `openapi()` descriptor as the config schema resolves it. */
export type ResolvedOpenApiAdapter = AdapterDescriptor<
  "openapi",
  ResolvedOpenApiOptions
>;

export const openapiAdapterSchema = adapterDescriptorSchema(
  "openapi",
  openapiOptionsSchema
);

/**
 * An OpenAPI reference. By default Blume parses the spec with Scalar's parser
 * and renders its own UI: one real page per operation, grouped by tag in the
 * sidebar and included in site search, llms.txt, and OG. Pass
 * `renderer: scalar()` to embed the Scalar SPA instead (a single
 * self-contained route that doesn't weave into the sidebar or search).
 */
export const openapi = (options: OpenApiOptions): OpenApiAdapter => ({
  kind: "openapi",
  options,
  requiredSecrets: [],
  runtimeDeps: rendererRuntimeDeps(options.renderer),
});

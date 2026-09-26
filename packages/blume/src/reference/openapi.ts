import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import {
  liftSpec,
  openapiSourceSchema,
  overlaysHaveSpec,
  overlaysNeedSpecIssue,
  hasSources,
  missingSourcesIssue,
  rendererRemovedHint,
  sharedOptions,
} from "./options.ts";
import type { OpenApiSourceOptions, PlaygroundOptions } from "./options.ts";

/** Options for {@link openapi}. */
export interface OpenApiOptions {
  /**
   * Code-sample languages generated per operation (Blume renderer), in
   * order. Defaults to `["curl", "js", "python"]`; `false` generates none, so
   * only the spec's own `x-codeSamples` show.
   */
  codeSamples?: string[] | false;
  /** Start nested schema rows expanded rather than collapsed (Blume renderer). Defaults to `false`. */
  expandSchemas?: boolean;
  /**
   * The interactive "Try it" panel (Blume renderer). On by default; `false`
   * hides it. The object form sets `proxy`, the CORS escape hatch the Send
   * button routes requests through: a proxy URL, or `true` for the built-in
   * `/_api-proxy` endpoint (which needs server output: a host adapter such as
   * `vercel()` in `deployment`).
   */
  playground?: PlaygroundOptions;
  /**
   * OpenAPI Overlay documents for `spec`, applied in order before it renders.
   * With `sources`, each source takes its own `overlays`.
   */
  overlays?: string[];
  /** Where the reference mounts. Defaults to `/reference`. */
  route?: string;
  /** One or more specs; each renders on its own route by default. */
  sources?: OpenApiSourceOptions[];
  /** Shorthand for a single source: `sources: [{ spec }]`. */
  spec?: string;
}

export const openapiOptionsSchema = z
  .strictObject(
    {
      ...sharedOptions({
        codeSamples: ["curl", "js", "python"],
        route: "/reference",
      }),
      /** Start nested schema rows expanded rather than collapsed (Blume renderer). */
      expandSchemas: z.boolean().default(false),
      /** Overlays for the `spec` shorthand. */
      overlays: z.array(z.string()).optional(),
      /** One or more specs; each renders on its own route by default. */
      sources: z.array(openapiSourceSchema).default([]),
    },
    rendererRemovedHint
  )
  .refine(overlaysHaveSpec, overlaysNeedSpecIssue)
  .transform(liftSpec(openapiSourceSchema))
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
 * An OpenAPI reference. Blume parses the spec with Scalar's parser and renders
 * its own UI: one real page per operation, grouped by tag in the sidebar and
 * included in site search, llms.txt, and OG. To embed the Scalar SPA instead
 * (a single self-contained route that doesn't weave into the sidebar or
 * search), list a `scalar()` adapter. Blume's renderer parses at generate
 * time and needs no runtime dependency.
 */
export const openapi = (options: OpenApiOptions): OpenApiAdapter => ({
  kind: "openapi",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

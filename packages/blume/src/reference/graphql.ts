import { z } from "zod";

import type { AdapterDescriptor } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import {
  graphqlSourceSchema,
  liftSpec,
  hasSources,
  missingSourcesIssue,
  sharedOptions,
} from "./options.ts";
import type { GraphqlSourceOptions, PlaygroundOptions } from "./options.ts";

/** Options for {@link graphql}. */
export interface GraphqlOptions {
  /** Code-sample languages shown per operation. Defaults to `["curl", "js", "python"]`. */
  codeSamples?: string[];
  /**
   * URL of the live GraphQL endpoint the playground and code samples target —
   * a schema, unlike an OpenAPI document, names no server. Applies to every
   * source; a per-source `endpoint` wins.
   */
  endpoint?: string;
  /**
   * The interactive "Try it" panel. On by default; `false` hides it. The
   * object form sets `proxy`, the CORS escape hatch the Send button routes
   * requests through: a proxy URL, or `true` for the built-in `/_api-proxy`
   * endpoint (which requires `deployment.output: "server"`).
   */
  playground?: PlaygroundOptions;
  /** Where the reference mounts. Defaults to `/graphql`. */
  route?: string;
  /** One or more schemas; each renders on its own route by default. */
  sources?: GraphqlSourceOptions[];
  /** Shorthand for a single source: `sources: [{ spec }]`. */
  spec?: string;
}

/**
 * No `renderer` (the Scalar SPA reads OpenAPI documents only) and no
 * `expandSchemas` (GraphQL field tables have no nesting) — everything else,
 * the playground normalization included, is the shared reference shape.
 */
export const graphqlOptionsSchema = z
  .strictObject({
    ...sharedOptions({
      codeSamples: ["curl", "js", "python"],
      route: "/graphql",
    }),
    /** Default live endpoint URL for every source (per-source `endpoint` wins). */
    endpoint: z.string().optional(),
    /** One or more schemas; each renders on its own route by default. */
    sources: z.array(graphqlSourceSchema).default([]),
  })
  .transform(liftSpec(graphqlSourceSchema))
  .refine(hasSources, missingSourcesIssue("graphql"));

/** `graphql()` options with every default applied and `spec` folded into `sources`. */
export type ResolvedGraphqlOptions = z.output<typeof graphqlOptionsSchema>;

export type GraphqlAdapter = AdapterDescriptor<"graphql", GraphqlOptions>;

/** A `graphql()` descriptor as the config schema resolves it. */
export type ResolvedGraphqlAdapter = AdapterDescriptor<
  "graphql",
  ResolvedGraphqlOptions
>;

export const graphqlAdapterSchema = adapterDescriptorSchema(
  "graphql",
  graphqlOptionsSchema
);

/**
 * A GraphQL reference. Blume lowers the schema (SDL or introspection JSON) to
 * one real page per root field — grouped as Queries/Mutations/Subscriptions —
 * plus one page per named type (Objects, Input Objects, Enums, Interfaces,
 * Unions, Scalars), all included in the sidebar, search, llms.txt, and OG.
 * Always Blume-rendered: the Scalar SPA reads OpenAPI documents only, so
 * there is no `renderer` to pass.
 */
export const graphql = (options: GraphqlOptions): GraphqlAdapter => ({
  kind: "graphql",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

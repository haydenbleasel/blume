import { z } from "zod";

/**
 * The option pieces every reference adapter shares: a spec source, the "Try
 * it" playground normalization, and the `spec` shorthand that folds into
 * `sources` at parse. Kept apart from the kind modules so `openapi()`,
 * `asyncapi()`, and `graphql()` validate one definition of each.
 */

const isBoolean = <Value>(value: Value): value is Value & boolean =>
  typeof value === "boolean";

/**
 * A single spec rendered by a reference. `spec` is a local path or an
 * `http(s)` URL (an OpenAPI document for `openapi()`, an AsyncAPI document
 * for `asyncapi()`, SDL or introspection JSON for `graphql()`).
 */
export const referenceSourceSchema = z.strictObject({
  /** Include generated pages from this spec in llms.txt/llms-full.txt. */
  includeInLlms: z.boolean().default(true),
  /** Include generated pages from this spec in site search. */
  includeInSearch: z.boolean().default(true),
  /** Nav/section label for this source. */
  label: z.string().optional(),
  /** Emit noindex metadata and omit generated pages from the sitemap. */
  noindex: z.boolean().default(false),
  /** Per-source route; defaults to the adapter's `route` (or a derived path). */
  route: z.string().optional(),
  /**
   * Append the English "Reference for the … endpoint in the … API." sentence
   * to every generated operation page's meta description. On by default, so
   * terse specs still ship distinct, snippet-length descriptions; set to
   * `false` on a non-English site to describe pages with the spec's own prose
   * alone (falling back to the page title when an operation has none).
   */
  seoDescriptionSuffix: z.boolean().default(true),
  /** Local path or `http(s)` URL to the spec. */
  spec: z.string(),
});

/** One spec source, as `openapi()` and `asyncapi()` accept it. */
export interface ReferenceSourceOptions {
  /** Include generated pages from this spec in llms.txt/llms-full.txt. Defaults to `true`. */
  includeInLlms?: boolean;
  /** Include generated pages from this spec in site search. Defaults to `true`. */
  includeInSearch?: boolean;
  /** Nav/section label for this source. */
  label?: string;
  /** Emit noindex metadata and omit generated pages from the sitemap. Defaults to `false`. */
  noindex?: boolean;
  /** Per-source route; defaults to the adapter's `route` (or a derived path). */
  route?: string;
  /**
   * Append the generated English "Reference for …" sentence to every
   * operation page's meta description. Defaults to `true`; set `false` on a
   * non-English site to keep the spec's own prose alone.
   */
  seoDescriptionSuffix?: boolean;
  /** Local path or `http(s)` URL to the spec. */
  spec: string;
}

/** A spec source with every default applied. */
export type ResolvedReferenceSource = z.output<typeof referenceSourceSchema>;

/**
 * A single GraphQL schema: the shared source shape plus `endpoint`, the live
 * GraphQL API URL the playground and code samples target (a schema, unlike an
 * OpenAPI document, names no server).
 */
export const graphqlSourceSchema = referenceSourceSchema.extend({
  /** URL of the live GraphQL endpoint (playground + code samples). */
  endpoint: z.string().optional(),
});

/** One schema source, as `graphql()` accepts it. */
export interface GraphqlSourceOptions extends ReferenceSourceOptions {
  /** URL of the live GraphQL endpoint (playground + code samples); wins over the adapter's `endpoint`. */
  endpoint?: string;
}

/** A GraphQL schema source with every default applied. */
export type ResolvedGraphqlSource = z.output<typeof graphqlSourceSchema>;

/**
 * The interactive "Try it" panel on operation pages (Blume renderer). On by
 * default; `false` hides it. The object form keeps it on and sets `proxy`,
 * the CORS escape hatch the Send button routes requests through: a proxy URL,
 * or `true` for the built-in `/_api-proxy` endpoint (which requires
 * `deployment.output: "server"`). Booleans normalize to the object shape so
 * consumers read `{ enabled, proxy }` directly. `proxy` applies to the
 * HTTP-posting playgrounds (OpenAPI, GraphQL) — an event composer's WebSocket
 * connect is direct. One schema for every reference kind, so the
 * normalization can never drift between them.
 */
export const playgroundSchema = z
  .union([
    z.boolean(),
    z.strictObject({
      enabled: z.boolean().default(true),
      proxy: z.union([z.boolean(), z.string()]).default(false),
    }),
  ])
  .default(true)
  .transform((value) =>
    isBoolean(value) ? { enabled: value, proxy: false } : value
  );

/** The `playground` option as a factory accepts it. */
export type PlaygroundOptions =
  | boolean
  | {
      /** Render the panel. Defaults to `true`. */
      enabled?: boolean;
      /** CORS proxy: a URL, or `true` for the built-in `/_api-proxy` route. Defaults to `false`. */
      proxy?: boolean | string;
    };

/** The playground with its booleans normalized: `{ enabled, proxy }`. */
export type ResolvedPlayground = z.output<typeof playgroundSchema>;

/**
 * The options every kind shares, with that kind's defaults for the mount
 * route and code-sample set. `spec` is the single-source shorthand; the kind
 * schema folds it into `sources` with {@link liftSpec}.
 */
export const sharedOptions = (defaults: {
  codeSamples: string[];
  route: string;
}) => ({
  /** Code-sample languages/tools shown per operation (Blume renderer). */
  codeSamples: z.array(z.string()).default(defaults.codeSamples),
  /** The "Try it" panel; see {@link playgroundSchema}. */
  playground: playgroundSchema,
  /** Where the reference mounts. */
  route: z.string().default(defaults.route),
  /** Shorthand for a single source: `sources: [{ spec }]`. */
  spec: z.string().optional(),
});

/**
 * Resolve the `spec` shorthand into `sources` so downstream code reads one
 * field: the shorthand becomes the first source (with the source defaults
 * applied through the source schema itself, so the two can never drift) and
 * the `spec` key is dropped. An adapter with neither renders nothing, which
 * is a config mistake rather than a choice — `refine` it away with
 * {@link hasSources}.
 */
export const liftSpec =
  <Source extends { spec: string }>(
    sourceSchema: z.ZodType<Source, { spec: string }>
  ) =>
  <Options extends { sources: Source[]; spec?: string }>({
    spec,
    ...options
  }: Options): Omit<Options, "spec"> => ({
    ...options,
    sources:
      spec === undefined
        ? options.sources
        : [sourceSchema.parse({ spec }), ...options.sources],
  });

/** Whether an adapter has anything to render; pairs with {@link missingSourcesIssue}. */
export const hasSources = (options: { sources: { spec: string }[] }): boolean =>
  options.sources.length > 0;

/** The refinement issue for a source-less adapter, naming its factory. */
export const missingSourcesIssue = (factory: string) => ({
  message: `${factory}() renders nothing without a spec — set \`spec\` or at least one \`sources\` entry.`,
  path: ["sources"],
});

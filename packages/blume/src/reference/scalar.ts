import { z } from "zod";

import type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import {
  hasSources,
  missingSourcesIssue,
  overlaysHaveSpec,
  overlaysNeedSpecIssue,
  overlaysSchema,
} from "./options.ts";

/**
 * What the generated Scalar page imports. Declared on every `scalar()`
 * descriptor so the generated project lists it, which is what lets Astro's
 * framework-package crawl bundle the embed.
 */
export const SCALAR_RUNTIME_DEPS: readonly string[] = ["@scalar/astro"];

/**
 * A single document rendered by a `scalar()` reference. Scalar reads OpenAPI
 * and AsyncAPI documents and detects which it was given, so there is one
 * source shape for both. The embed sits outside Blume's search and llms.txt,
 * so of the native per-source controls only `noindex` applies here.
 */
export const scalarSourceSchema = z.strictObject({
  /** Nav/section label for this source. */
  label: z.string().optional(),
  /** Emit noindex metadata and omit the page from the sitemap. */
  noindex: z.boolean().default(false),
  /**
   * OpenAPI Overlay documents applied in order to the document before it's
   * embedded (inlined, so a remote spec with overlays is fetched at build).
   */
  overlays: overlaysSchema,
  /** Per-source route; defaults to the adapter's `route` (or a derived path). */
  route: z.string().optional(),
  /** Local path or `http(s)` URL to the OpenAPI or AsyncAPI document. */
  spec: z.string(),
});

/** One document source, as `scalar()` accepts it. */
export interface ScalarSourceOptions {
  /** Nav/section label for this source. */
  label?: string;
  /** Emit noindex metadata and omit the page from the sitemap. Defaults to `false`. */
  noindex?: boolean;
  /** OpenAPI Overlay documents applied in order to the document before it's embedded. */
  overlays?: string[];
  /** Per-source route; defaults to the adapter's `route` (or a derived path). */
  route?: string;
  /** Local path or `http(s)` URL to the OpenAPI or AsyncAPI document. */
  spec: string;
}

/** A source with every default applied. */
export type ResolvedScalarSource = z.output<typeof scalarSourceSchema>;

/**
 * `scalar()` options with every default applied and `spec` folded into
 * `sources`; every key beyond the named ones is forwarded Scalar config.
 */
export type ResolvedScalarOptions = {
  route: string;
  sources: ResolvedScalarSource[];
  theme?: string;
} & { [option: string]: JsonValue };

/** The options {@link scalar} maps itself. */
export interface ScalarNamedOptions {
  /** OpenAPI Overlay documents for `spec`; with `sources`, each takes its own. */
  overlays?: string[];
  /** Where the reference mounts. Defaults to `/reference`. */
  route?: string;
  /** One or more documents; each renders on its own route by default. */
  sources?: ScalarSourceOptions[];
  /** Shorthand for a single source: `sources: [{ spec }]`. */
  spec?: string;
  /** A Scalar theme name (`purple`, `moon`, …). Unset keeps Scalar's default theme with Blume's accent and radius layered on top. */
  theme?: string;
}

/**
 * Options for {@link scalar}: the source, route, and `theme` Blume maps, plus
 * any other [Scalar configuration](https://github.com/scalar/scalar/blob/main/documentation/configuration.md)
 * key, forwarded verbatim to the embedded `<ScalarComponent>` (`localization`,
 * `agent`, `hideTestRequestButton`, `orderSchemaPropertiesBy`, …). Blume
 * doesn't mirror Scalar's config surface, so this is a full escape hatch: a
 * forwarded key wins over Blume's own derived spec/theme config. JSON values
 * only — the configuration is inlined into the generated page. `sources` is
 * Blume's (one page per document); Scalar's own multi-document `sources`
 * can't be forwarded.
 */
export type ScalarOptions = ScalarNamedOptions & {
  [option: string]: JsonValue;
};

/**
 * `spec` is the single-source shorthand and folds into `sources` at parse
 * (through the source schema, so the two can never drift); every key beyond
 * the named ones is Scalar configuration and passes through untouched.
 */
export const scalarOptionsSchema = z
  .object({
    /** Overlays for the `spec` shorthand. */
    overlays: z.array(z.string()).optional(),
    /** Where the reference mounts. */
    route: z.string().default("/reference"),
    /** One or more documents; each renders on its own route by default. */
    sources: z.array(scalarSourceSchema).default([]),
    /** Shorthand for a single source: `sources: [{ spec }]`. */
    spec: z.string().optional(),
    /** A Scalar theme name; unset layers Blume's accent and radius on Scalar's default theme. */
    theme: z.string().optional(),
  })
  .catchall(z.json())
  .refine(overlaysHaveSpec, overlaysNeedSpecIssue)
  .transform(
    ({ overlays, spec, sources, ...options }): ResolvedScalarOptions => ({
      ...options,
      sources:
        spec === undefined
          ? sources
          : [
              scalarSourceSchema.parse(
                overlays ? { overlays, spec } : { spec }
              ),
              ...sources,
            ],
    })
  )
  .refine(hasSources, missingSourcesIssue("scalar"));

export type ScalarAdapter = AdapterDescriptor<"scalar", ScalarOptions>;

/** A `scalar()` descriptor as the config schema resolves it. */
export type ResolvedScalarAdapter = AdapterDescriptor<
  "scalar",
  ResolvedScalarOptions
>;

export const scalarAdapterSchema = adapterDescriptorSchema(
  "scalar",
  scalarOptionsSchema
);

/**
 * An API reference rendered by [Scalar](https://scalar.com)'s self-contained
 * UI — its own sidebar, search, theme, and request client on a single route —
 * instead of Blume's native operation pages. Takes an OpenAPI or AsyncAPI
 * document (Scalar detects which); a GraphQL schema has no Scalar embed.
 * Blume's per-page controls don't apply: the embed doesn't weave into the
 * sidebar, search, or llms.txt, and it brings its own request client in place
 * of the Try it playground.
 */
export const scalar = (options: ScalarOptions): ScalarAdapter => ({
  kind: "scalar",
  options,
  requiredSecrets: [],
  runtimeDeps: [...SCALAR_RUNTIME_DEPS],
});

import { z } from "zod";

import type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";

/** The option {@link scalar} maps itself. */
export interface ScalarNamedOptions {
  /** A Scalar theme name (`purple`, `moon`, …). Unset keeps Scalar's default theme with Blume's accent and radius layered on top. */
  theme?: string;
}

/**
 * Options for {@link scalar}: `theme` plus any other
 * [Scalar configuration](https://github.com/scalar/scalar/blob/main/documentation/configuration.md)
 * key, forwarded verbatim to the embedded `<ScalarComponent>` (`localization`,
 * `agent`, `hideTestRequestButton`, `orderSchemaPropertiesBy`, …). Blume
 * doesn't mirror Scalar's config surface, so this is a full escape hatch: a
 * forwarded key wins over Blume's own derived spec/theme config. JSON values
 * only — the configuration is inlined into the generated page.
 */
export type ScalarOptions = ScalarNamedOptions & {
  [option: string]: JsonValue;
};

export const scalarOptionsSchema = z
  .object({
    theme: z.string().optional(),
  })
  .catchall(z.json());

/** The renderer descriptor {@link scalar} returns. */
export type ScalarRenderer = AdapterDescriptor<"scalar", ScalarOptions>;

/**
 * Render a reference with [Scalar](https://scalar.com)'s self-contained API
 * reference UI — its own sidebar, search, theme, and request client on a
 * single route — instead of Blume's native operation pages. Pass it as the
 * `renderer` of `openapi()` or `asyncapi()`; `graphql()` takes no renderer,
 * because the Scalar SPA reads OpenAPI documents only.
 *
 * The generated page imports `@scalar/astro`, so the renderer declares it as
 * a runtime dependency: the generated project lists it, which is what lets
 * Astro's framework-package crawl bundle the embed.
 */
export const scalar = (options: ScalarOptions = {}): ScalarRenderer => ({
  kind: "scalar",
  options,
  requiredSecrets: [],
  runtimeDeps: ["@scalar/astro"],
});

/**
 * Validates a `scalar()` descriptor and resolves it through the factory, so a
 * descriptor that went through JSON (the generated data snapshot, a hand-typed
 * literal) carries the canonical runtime dependency.
 */
export const scalarRendererSchema = adapterDescriptorSchema(
  "scalar",
  scalarOptionsSchema
).transform((value): ScalarRenderer => scalar(value.options));

/**
 * The runtime dependencies a reference adapter declares: its renderer's, since
 * the Blume renderer parses at generate time and needs nothing of its own.
 * Hoisted onto the adapter so consumers read one `runtimeDeps` list.
 */
export const rendererRuntimeDeps = (renderer?: ScalarRenderer): string[] =>
  renderer ? [...renderer.runtimeDeps] : [];

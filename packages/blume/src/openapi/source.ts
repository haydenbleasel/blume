import matter from "../core/frontmatter.ts";
import { hashText } from "../core/sources/cache.ts";
import type {
  ContentSource,
  SourceContext,
  SourceEntry,
  SourceLoadResult,
} from "../core/sources/types.ts";
import type { Diagnostic } from "../core/types.ts";
import { extractOperations } from "./model.ts";
import type { ApiOperationRef, ApiSpecData, OpenApiData } from "./model.ts";
import { parseSpec } from "./parse.ts";
import type { ReferenceSource } from "./references.ts";
import { operationMdx, overviewMdx } from "./render-mdx.ts";
import type { RenderedPage } from "./render-mdx.ts";

/**
 * The staged content source behind Blume's own OpenAPI renderer. Each configured
 * spec is parsed once here, then lowered into one MDX page per operation plus an
 * overview page — so operations become first-class Blume pages (real routes,
 * sidebar, search, i18n, OG) and the parsed documents are handed to the
 * generated `blume:openapi` module for the UI components to render.
 */

/** A content source that also exposes the specs it parsed during `load()`. */
export interface OpenApiContentSource extends ContentSource {
  readonly kind: "openapi-source";
  /** Parsed spec data, populated by `load()`; `{}` before the first load. */
  openApiData: () => OpenApiData;
}

/** Narrow a content source to the OpenAPI source (to read its parsed specs). */
export const isOpenApiSource = (
  source: ContentSource
): source is OpenApiContentSource =>
  (source as Partial<OpenApiContentSource>).kind === "openapi-source";

/** Route (`/reference/pet/add-pet`) to a staged content ref, without extension. */
const routeToRef = (route: string): string => route.replace(/^\/+/u, "");

const toEntry = (rendered: RenderedPage, ref: string): SourceEntry => {
  const raw = matter.stringify(`${rendered.body}\n`, rendered.data);
  return {
    body: { format: "mdx", text: rendered.body },
    data: rendered.data,
    hash: hashText(raw),
    raw,
    ref,
  };
};

/** All staged entries for one spec: operations first, overview last. */
const specEntries = (
  spec: ApiSpecData,
  operations: ApiOperationRef[]
): SourceEntry[] => {
  const entries = operations.map((operation) =>
    toEntry(operationMdx(spec, operation), `${routeToRef(operation.route)}.mdx`)
  );
  // Overview last so an operation sets the section's routePath before the index
  // page is inserted (the group's routePath is derived from its first child).
  entries.push(
    toEntry(overviewMdx(spec), `${routeToRef(spec.route)}/index.mdx`)
  );
  return entries;
};

interface LoadedSpec {
  slug: string;
  spec: ApiSpecData;
  entries: SourceEntry[];
  /** Non-fatal notes from the load (e.g. an offline cache fallback). */
  diagnostics: Diagnostic[];
}

export const openApiSource = (
  references: ReferenceSource[],
  ctx: SourceContext
): OpenApiContentSource => {
  let parsed: OpenApiData = {};

  const loadReference = async (
    reference: ReferenceSource
  ): Promise<LoadedSpec | Diagnostic> => {
    try {
      const { document, warnings } = await parseSpec(
        reference.spec,
        ctx.projectRoot,
        { cacheDir: ctx.cacheDir, refresh: ctx.refresh }
      );
      const { operations, tags } = extractOperations(document, reference.route);
      const info = document.info ?? { title: reference.label, version: "" };
      const spec: ApiSpecData = {
        codeSamples: reference.display.codeSamples,
        description: info.description ?? "",
        document,
        expandSchemas: reference.display.expandSchemas,
        label: reference.label,
        operations: Object.fromEntries(
          operations.map((operation) => [operation.key, operation])
        ),
        route: reference.route,
        slug: reference.slug,
        tags,
        title: info.title ?? reference.label,
        version: info.version ?? "",
      };
      return {
        diagnostics: warnings.map((message) => ({
          code: "BLUME_OPENAPI_STALE",
          message,
          severity: "warning" as const,
        })),
        entries: specEntries(spec, operations),
        slug: reference.slug,
        spec,
      };
    } catch (error) {
      return {
        code: "BLUME_OPENAPI_UNAVAILABLE",
        message: `Could not load OpenAPI spec "${reference.spec}" for ${reference.route} (${(error as Error).message}); its reference pages were skipped.`,
        // A configured-but-unloadable spec ships a dead nav tab (a 404 route),
        // so fail loudly in build (blocks under --strict) while staying a warning
        // in dev so offline work still runs.
        severity: ctx.mode === "build" ? "error" : "warning",
        suggestion:
          "Check the spec URL/path is reachable from the build environment; behind a proxy, set HTTP(S)_PROXY.",
      };
    }
  };

  const load = async (): Promise<SourceLoadResult> => {
    const results = await Promise.all(references.map(loadReference));
    const entries: SourceEntry[] = [];
    const diagnostics: Diagnostic[] = [];
    const data: OpenApiData = {};
    for (const result of results) {
      if ("severity" in result) {
        diagnostics.push(result);
        continue;
      }
      data[result.slug] = result.spec;
      entries.push(...result.entries);
      diagnostics.push(...result.diagnostics);
    }
    parsed = data;
    return { diagnostics, entries };
  };

  return {
    kind: "openapi-source",
    load,
    name: "openapi",
    openApiData: () => parsed,
    staged: true,
  };
};

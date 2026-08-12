import { withBasePath } from "../core/base-path.ts";
import matter from "../core/frontmatter.ts";
import type { FolderMeta } from "../core/schema.ts";
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
import { InvalidSpecError, parseSpec } from "./parse.ts";
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
  operations: ApiOperationRef[],
  reference: ReferenceSource
): SourceEntry[] => {
  const entries = operations.map((operation) =>
    toEntry(
      operationMdx(spec, operation, reference),
      `${routeToRef(operation.route)}.mdx`
    )
  );
  // Overview last so an operation sets the section's routePath before the index
  // page is inserted (the group's routePath is derived from its first child).
  // A root-mounted reference refs `index.mdx`, not `/index.mdx`.
  const base = routeToRef(spec.route);
  entries.push(
    toEntry(
      overviewMdx(spec, reference),
      base ? `${base}/index.mdx` : "index.mdx"
    )
  );
  return entries;
};

/**
 * Label each tag's sidebar group with the spec's own tag name. The group label
 * is otherwise re-humanized from the tag's route slug (split on hyphens,
 * title-cased), which mangles authored casing and symbols — `OAuth2` →
 * "Oauth2", `Größe` → "Größe" only by luck of the slug. Keys are the tag
 * directories under the reference route, the same group paths `meta.ts` files
 * use, so user-authored meta still overrides these.
 */
const tagFolderMeta = (
  spec: ApiSpecData,
  tags: { slug: string; name: string }[]
): Record<string, FolderMeta> => {
  const base = routeToRef(spec.route);
  return Object.fromEntries(
    tags.map((tag) => [
      base ? `${base}/${tag.slug}` : tag.slug,
      { title: tag.name },
    ])
  );
};

interface LoadedSpec {
  slug: string;
  spec: ApiSpecData;
  entries: SourceEntry[];
  /** Sidebar-group labels for the spec's tag directories. */
  folderMeta: Record<string, FolderMeta>;
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
      const {
        operations,
        tags,
        warnings: extractWarnings,
      } = extractOperations(document, reference.route);
      const info = document.info ?? { title: reference.label, version: "" };
      // The playground proxy resolves here, not client-side: `true` selects
      // the built-in `/_api-proxy` route (mounted under the site `basePath`,
      // like every served URL this module emits), a non-empty string is an
      // external proxy used verbatim, and anything else (`false`, `""`)
      // means the Send button fetches the API directly.
      const { proxy: configuredProxy } = reference.display.playground;
      let proxy: string | false = false;
      if (configuredProxy === true) {
        proxy = withBasePath(reference.basePath, "/_api-proxy");
      } else if (
        typeof configuredProxy === "string" &&
        configuredProxy !== ""
      ) {
        proxy = configuredProxy;
      }
      const spec: ApiSpecData = {
        codeSamples: reference.display.codeSamples,
        description: info.description ?? "",
        document,
        expandSchemas: reference.display.expandSchemas,
        label: reference.label,
        // Operation pages flow through the content pipeline, which mounts them
        // under the site-wide `basePath` (staged entry refs below stay
        // base-less); serialize the served route so components link to the
        // pages' real URLs.
        operations: Object.fromEntries(
          operations.map((operation) => [
            operation.key,
            {
              ...operation,
              route: withBasePath(reference.basePath, operation.route),
            },
          ])
        ),
        playground: { enabled: reference.display.playground.enabled, proxy },
        route: reference.route,
        slug: reference.slug,
        tags,
        title: info.title ?? reference.label,
        version: info.version ?? "",
      };
      return {
        diagnostics: [
          ...warnings.map((message) => ({
            code: "BLUME_OPENAPI_STALE",
            message,
            severity: "warning" as const,
          })),
          ...extractWarnings.map((message) => ({
            code: "BLUME_OPENAPI_REF_PATH_ITEM",
            message: `In OpenAPI spec "${reference.spec}": ${message}`,
            severity: "warning" as const,
          })),
          // A document with no operations (say, a config file that happens to
          // parse as YAML) would otherwise build a nav tab onto an empty
          // reference with no hint why.
          ...(operations.length === 0
            ? [
                {
                  code: "BLUME_OPENAPI_EMPTY",
                  message: `OpenAPI spec "${reference.spec}" for ${reference.route} declares no operations; its API reference is empty.`,
                  severity: "warning" as const,
                  suggestion:
                    "Check the spec points at an OpenAPI document with operations under `paths`.",
                },
              ]
            : []),
        ],
        entries: specEntries(spec, operations, reference),
        folderMeta: tagFolderMeta(spec, tags),
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
        // A readable-but-invalid file is a content problem, not a network one;
        // only point at reachability for actual fetch/read failures.
        suggestion:
          error instanceof InvalidSpecError
            ? "Point the spec at an OpenAPI document (a YAML or JSON file with an object at the top level)."
            : "Check the spec URL/path is reachable from the build environment; behind a proxy, set HTTP(S)_PROXY.",
      };
    }
  };

  const load = async (): Promise<SourceLoadResult> => {
    const results = await Promise.all(references.map(loadReference));
    const entries: SourceEntry[] = [];
    // Route collisions recorded while deduping (see `blumeReferences`): a
    // dropped source loses a whole spec's pages, so warn even when the kept
    // spec loads cleanly.
    const diagnostics: Diagnostic[] = references.flatMap((reference) =>
      (reference.collisions ?? []).map((message) => ({
        code: "BLUME_OPENAPI_ROUTE_COLLISION",
        message,
        severity: "warning" as const,
      }))
    );
    const data: OpenApiData = {};
    const folderMeta: Record<string, FolderMeta> = {};
    for (const result of results) {
      if ("severity" in result) {
        diagnostics.push(result);
        continue;
      }
      data[result.slug] = result.spec;
      entries.push(...result.entries);
      Object.assign(folderMeta, result.folderMeta);
      diagnostics.push(...result.diagnostics);
    }
    parsed = data;
    return { diagnostics, entries, folderMeta };
  };

  return {
    kind: "openapi-source",
    load,
    name: "openapi",
    openApiData: () => parsed,
    staged: true,
  };
};

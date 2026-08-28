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
import { extractAsyncApiOperations } from "./asyncapi.ts";
import type { AsyncApiDocument } from "./asyncapi.ts";
import { extractGraphqlOperations } from "./graphql.ts";
import type { GraphqlDocument } from "./graphql.ts";
import { extractOperations } from "./model.ts";
import type {
  ApiDocument,
  ApiOperationRef,
  ApiSpecData,
  ApiTagRef,
  OpenApiData,
} from "./model.ts";
import {
  InvalidSpecError,
  parseAsyncApiSpec,
  parseGraphqlSpec,
  parseSpec,
} from "./parse.ts";
import type { ReferenceSource } from "./references.ts";
import { operationMdx, overviewMdx } from "./render-mdx.ts";
import type { RenderedPage } from "./render-mdx.ts";

/**
 * The staged content source behind Blume's own API reference renderer (OpenAPI
 * and AsyncAPI alike). Each configured spec is parsed once here, then lowered
 * into one MDX page per operation plus an overview page — so operations become
 * first-class Blume pages (real routes, sidebar, search, i18n, OG) and the
 * parsed documents are handed to the generated `blume:openapi` module for the
 * UI components to render. The source keeps its historical `openapi` name for
 * both kinds — downstream consumers (`ai.llmsTxt.openapi`, the llms noindex
 * exemption) key on it as "the generated API reference source".
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
  "kind" in source && source.kind === "openapi-source";

/** Route (`/reference/pet/add-pet`) to a staged content ref, without extension. */
const routeToRef = (route: string): string => route.replace(/^\/+/u, "");

/** Human label per spec kind, so one kind's failure never reads as another's. */
const KIND_LABELS = {
  asyncapi: "AsyncAPI",
  graphql: "GraphQL",
  openapi: "OpenAPI",
} satisfies Record<ReferenceSource["kind"], string>;

/** Diagnostic-code prefix per spec kind. */
const CODE_PREFIXES = {
  asyncapi: "BLUME_ASYNCAPI",
  graphql: "BLUME_GRAPHQL",
  openapi: "BLUME_OPENAPI",
} satisfies Record<ReferenceSource["kind"], string>;

/**
 * Parse-level warning code per kind: an offline cache fallback for any kind,
 * plus lossy 2.x→3.0 conversion notes for AsyncAPI — hence the broader codes
 * there and for GraphQL (OpenAPI keeps its historical one).
 */
const SPEC_WARNING_CODES = {
  asyncapi: "BLUME_ASYNCAPI_SPEC_WARNING",
  graphql: "BLUME_GRAPHQL_SPEC_WARNING",
  openapi: "BLUME_OPENAPI_STALE",
} satisfies Record<ReferenceSource["kind"], string>;

/**
 * Extract-level skip code per kind. OpenAPI keeps its historical code (the
 * only extract warning it emits is the unresolved $ref path item); the
 * GraphQL extractor currently skips nothing, so its code is reserved.
 */
const SKIPPED_CODES = {
  asyncapi: "BLUME_ASYNCAPI_SKIPPED_OPERATION",
  graphql: "BLUME_GRAPHQL_SKIPPED",
  openapi: "BLUME_OPENAPI_REF_PATH_ITEM",
} satisfies Record<ReferenceSource["kind"], string>;

/** `_EMPTY` diagnostic suggestion per kind. */
const EMPTY_SUGGESTIONS = {
  asyncapi:
    "Check the spec points at an AsyncAPI document with `channels` and `operations`.",
  graphql:
    "Check the spec points at a GraphQL schema (SDL or introspection JSON) whose root types declare fields.",
  openapi:
    "Check the spec points at an OpenAPI document with operations under `paths`.",
} satisfies Record<ReferenceSource["kind"], string>;

/** `_UNAVAILABLE` suggestion for a readable-but-invalid spec, per kind. */
const INVALID_SUGGESTIONS = {
  asyncapi:
    "Point the spec at an AsyncAPI document (a YAML or JSON file with an object at the top level).",
  graphql:
    "Point the spec at a GraphQL schema — SDL text or an introspection JSON result.",
  openapi:
    "Point the spec at an OpenAPI document (a YAML or JSON file with an object at the top level).",
} satisfies Record<ReferenceSource["kind"], string>;

const toEntry = (rendered: RenderedPage, ref: string): SourceEntry => {
  const raw = matter.stringify(`${rendered.body}\n`, rendered.data);
  return {
    body: { format: "mdx", text: rendered.body },
    // Spread so the named frontmatter shape satisfies the open metadata
    // dictionary every source entry carries.
    data: { ...rendered.data },
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

/** One parsed spec, whichever front-end read it — the kind dispatch seam. */
interface ParsedReference {
  document: ApiDocument | AsyncApiDocument | GraphqlDocument;
  warnings: string[];
  operations: ApiOperationRef[];
  tags: ApiTagRef[];
  extractWarnings: string[];
}

const parseReference = async (
  reference: ReferenceSource,
  ctx: SourceContext
): Promise<ParsedReference> => {
  const options = { cacheDir: ctx.cacheDir, refresh: ctx.refresh };
  if (reference.kind === "asyncapi") {
    const { document, warnings } = await parseAsyncApiSpec(
      reference.spec,
      ctx.projectRoot,
      options
    );
    const extracted = extractAsyncApiOperations(document, reference.route);
    return {
      document,
      extractWarnings: extracted.warnings,
      operations: extracted.operations,
      tags: extracted.tags,
      warnings,
    };
  }
  if (reference.kind === "graphql") {
    const { document, warnings } = await parseGraphqlSpec(
      reference.spec,
      ctx.projectRoot,
      options
    );
    const extracted = extractGraphqlOperations(document, reference.route);
    return {
      document,
      extractWarnings: extracted.warnings,
      operations: extracted.operations,
      tags: extracted.tags,
      warnings,
    };
  }
  const { document, warnings } = await parseSpec(
    reference.spec,
    ctx.projectRoot,
    options
  );
  const extracted = extractOperations(document, reference.route);
  return {
    document,
    extractWarnings: extracted.warnings,
    operations: extracted.operations,
    tags: extracted.tags,
    warnings,
  };
};

export const openApiSource = (
  references: ReferenceSource[],
  ctx: SourceContext
): OpenApiContentSource => {
  let parsed: OpenApiData = {};

  const loadReference = async (
    reference: ReferenceSource
  ): Promise<LoadedSpec | Diagnostic> => {
    // Human label and diagnostic-code prefix for the spec's kind, so an
    // AsyncAPI failure never reads as an OpenAPI one.
    const kindLabel = KIND_LABELS[reference.kind];
    const codePrefix = CODE_PREFIXES[reference.kind];
    try {
      const { document, warnings, operations, tags, extractWarnings } =
        await parseReference(reference, ctx);
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
      } else if (configuredProxy !== false && configuredProxy !== "") {
        proxy = configuredProxy;
      }
      const spec: ApiSpecData = {
        codeSamples: reference.display.codeSamples,
        description: info.description ?? "",
        document,
        expandSchemas: reference.display.expandSchemas,
        kind: reference.kind,
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
      // Only GraphQL references carry a live endpoint (a schema names no
      // server); assigned separately so the key stays absent otherwise.
      if (reference.endpoint !== undefined) {
        spec.endpoint = reference.endpoint;
      }
      return {
        diagnostics: [
          ...warnings.map((message) => ({
            code: SPEC_WARNING_CODES[reference.kind],
            message,
            severity: "warning" as const,
          })),
          ...extractWarnings.map((message) => ({
            code: SKIPPED_CODES[reference.kind],
            message: `In ${kindLabel} spec "${reference.spec}": ${message}`,
            severity: "warning" as const,
          })),
          // A document with no operations (say, a config file that happens to
          // parse as YAML) would otherwise build a nav tab onto an empty
          // reference with no hint why.
          ...(operations.length === 0
            ? [
                {
                  code: `${codePrefix}_EMPTY`,
                  message: `${kindLabel} spec "${reference.spec}" for ${reference.route} declares no operations; its API reference is empty.`,
                  severity: "warning" as const,
                  suggestion: EMPTY_SUGGESTIONS[reference.kind],
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
        code: `${codePrefix}_UNAVAILABLE`,
        // SAFETY: spec loading fails with Error instances (fetch, read, and
        // parse errors alike); only the message is read for the diagnostic.
        message: `Could not load ${kindLabel} spec "${reference.spec}" for ${reference.route} (${(error as Error).message}); its reference pages were skipped.`,
        // A configured-but-unloadable spec ships a dead nav tab (a 404 route),
        // so fail loudly in build (blocks under --strict) while staying a warning
        // in dev so offline work still runs.
        severity: ctx.mode === "build" ? "error" : "warning",
        // A readable-but-invalid file is a content problem, not a network one;
        // only point at reachability for actual fetch/read failures.
        suggestion:
          error instanceof InvalidSpecError
            ? INVALID_SUGGESTIONS[reference.kind]
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

import type { Document, OperationObject } from "@scalar/openapi-types/3.1";

import type { AsyncApiAction, AsyncApiDocument } from "./asyncapi.ts";
import type { ReferenceKind } from "./references.ts";
import { slugify } from "./references.ts";

// The slug rules live with the reference resolver so operation routes and
// reference-source tokens can never drift apart; re-exported for existing
// importers.
export { slugify } from "./references.ts";

/**
 * Blume's own API reference model, shared by both spec kinds. OpenAPI specs
 * are parsed and upgraded to 3.1, AsyncAPI specs normalized to 3.x (see
 * `parse.ts`), with internal `$ref`s left intact — the document stays
 * JSON-serializable (a fully dereferenced graph can be circular), and the schema
 * components resolve refs against `document.components.schemas` at render time.
 * Each operation is flattened into an {@link ApiOperationRef} with a real,
 * per-operation route so it becomes a first-class Blume page.
 */

/** A normalized OpenAPI 3.1 document, internal `$ref`s intact. */
export type ApiDocument = Document;

/** The HTTP methods an OpenAPI path item may declare, in spec order. */
export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Group used for operations that declare no tag. */
const UNTAGGED = "Operations";

/** A stable, URL-safe key for an operation: its `operationId`, else method+path. */
export const operationKey = (
  method: string,
  path: string,
  operationId?: string
): string => {
  const fromId = operationId ? slugify(operationId) : "";
  return fromId || slugify(`${method}-${path}`);
};

/** One operation, flattened out of its document and mapped to a route. */
export interface ApiOperationRef {
  /** Stable key, unique within a spec; matches the MDX `<Operation id>`. */
  key: string;
  /** HTTP method (OpenAPI) or `send`/`receive` action (AsyncAPI). */
  method: HttpMethod | AsyncApiAction;
  /** Templated path, e.g. `/pets/{id}` — or the channel address (AsyncAPI). */
  path: string;
  /** Full site route for this operation's page, e.g. `/reference/pet/add-pet`. */
  route: string;
  /** Display tag name (first tag; `Operations` or the channel address when untagged). */
  tag: string;
  tagSlug: string;
  summary: string;
  description: string;
  /** The `operationId` (OpenAPI) or the `operations` map key (AsyncAPI). */
  operationId?: string;
  deprecated: boolean;
  /** The channel the operation acts on (AsyncAPI only). */
  channelId?: string;
}

/** A tag/section, in first-seen order. */
export interface ApiTagRef {
  slug: string;
  name: string;
  description: string;
}

/** Everything the runtime needs for one spec, serialized into `blume:openapi`. */
export interface ApiSpecData {
  /** Which front-end parsed the spec (and which components render it). */
  kind: ReferenceKind;
  /** Unique token used as the `<Operation source>` and the data-module key. */
  slug: string;
  /** Base route the spec's operations hang off, e.g. `/reference`. */
  route: string;
  label: string;
  title: string;
  version: string;
  description: string;
  document: ApiDocument | AsyncApiDocument;
  /** Operations keyed by {@link ApiOperationRef.key}. */
  operations: Record<string, ApiOperationRef>;
  tags: ApiTagRef[];
  /** Code-sample languages to render per operation. */
  codeSamples: string[];
  /** Whether nested schema rows start expanded. */
  expandSchemas: boolean;
  /**
   * The "Try it" playground: whether operation pages render it, and the
   * resolved proxy the Send button targets — `false` for direct requests, a
   * URL string otherwise (the built-in `/_api-proxy` route already carries
   * the site `basePath`).
   */
  playground: { enabled: boolean; proxy: string | false };
}

/** The generated `blume:openapi` module: specs keyed by {@link ApiSpecData.slug}. */
export type OpenApiData = Record<string, ApiSpecData>;

// The runtime object check stands guard because the document was parsed from
// arbitrary YAML/JSON: a spec can put a scalar where the type promises an
// operation object.
const isOperation = (
  value: OperationObject | undefined
): value is OperationObject => typeof value === "object" && value !== null;

/** A declared tag whose `name` really is a string at runtime, type aside. */
const hasTagName = (tag: SpecTag): tag is SpecTag =>
  typeof tag.name === "string";

/**
 * Assign each distinct tag name a unique slug. `slugify` can collapse
 * different names onto one value — any two punctuation-only tags (`!!!`,
 * `???`) both fall through to the `operations` fallback — and a shared slug
 * silently merges the tags' routes, sidebar groups, and overview sections.
 * Collisions gain `-2`, `-3`, … in first-seen order. Shared with the AsyncAPI
 * extractor (`asyncapi.ts`), whose untagged fallback groups are channel
 * addresses.
 */
export const tagSlugger = (): ((name: string) => string) => {
  const assigned = new Map<string, string>();
  const taken = new Set<string>();
  return (name) => {
    const existing = assigned.get(name);
    if (existing) {
      return existing;
    }
    const base = slugify(name) || "operations";
    let slug = base;
    for (let suffix = 2; taken.has(slug); suffix += 1) {
      slug = `${base}-${suffix}`;
    }
    taken.add(slug);
    assigned.set(name, slug);
    return slug;
  };
};

/** An operation before the collector assigns its unique key and route. */
type CollectedOperation = Omit<ApiOperationRef, "route" | "tagSlug">;

/** A document's declared tag entry (`tags[n]`). */
type SpecTag = NonNullable<ApiDocument["tags"]>[number];

/** The flattened output both extractors produce. */
export interface CollectedOperations {
  operations: ApiOperationRef[];
  tags: ApiTagRef[];
}

/** The collector handle: feed operations in, read the flattened output out. */
export interface OperationCollector {
  add: (entry: CollectedOperation) => void;
  finish: () => CollectedOperations;
}

/** {@link CollectedOperations} plus anything the extractor had to skip. */
export interface ExtractedOperations extends CollectedOperations {
  warnings: string[];
}

/**
 * The collector behind both extractors (OpenAPI here, AsyncAPI in
 * `asyncapi.ts`): first-seen tag ordering, key de-duplication (a repeated key
 * gains its method/action as a suffix), and the shared route template — so
 * URL shape and slug rules can never drift between the two spec kinds.
 */
export const operationCollector = (
  baseRoute: string,
  tagMeta: ReadonlyMap<string, string>
): OperationCollector => {
  const operations: ApiOperationRef[] = [];
  const tagOrder: string[] = [];
  const tagsSeen = new Set<string>();
  const seen = new Set<string>();
  const slugForTag = tagSlugger();

  const add = (entry: CollectedOperation): void => {
    const tagSlug = slugForTag(entry.tag);
    if (!tagsSeen.has(entry.tag)) {
      tagsSeen.add(entry.tag);
      tagOrder.push(entry.tag);
    }
    let { key } = entry;
    while (seen.has(key)) {
      key = `${key}-${entry.method}`;
    }
    seen.add(key);
    operations.push({
      ...entry,
      key,
      // A root-mounted reference (`route: "/"`) must not emit `//tag/key`.
      route: `${baseRoute === "/" ? "" : baseRoute}/${tagSlug}/${key}`,
      tagSlug,
    });
  };

  const finish = (): CollectedOperations => ({
    operations,
    tags: tagOrder.map((name) => ({
      description: tagMeta.get(name) ?? "",
      name,
      // The same slugger instance, so every tag resolves to the slug its
      // operations were routed under.
      slug: slugForTag(name),
    })),
  });

  return { add, finish };
};

/**
 * Flatten a 3.1 document into a route-mapped operation list and its ordered
 * tags. Operations inherit the first tag they declare; keys are de-duplicated so
 * a repeated `operationId` still yields distinct routes. `warnings` reports
 * anything skipped (a `$ref` path item), so missing operations aren't silent.
 */
export const extractOperations = (
  document: ApiDocument,
  baseRoute: string
): ExtractedOperations => {
  const warnings: string[] = [];
  const tagMeta = new Map(
    (document.tags ?? [])
      .filter(hasTagName)
      .map((tag) => [tag.name, tag.description ?? ""])
  );
  const collector = operationCollector(baseRoute, tagMeta);

  for (const [path, item] of Object.entries(document.paths ?? {})) {
    // A parsed spec can carry a null path item despite the type; skip it.
    if (!item) {
      continue;
    }
    if ("$ref" in item) {
      warnings.push(
        `Path "${path}" is a $ref to a shared path item; referenced path items are not resolved, so its operations are missing from the reference. Inline the path item under "paths" to render it.`
      );
      continue;
    }
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isOperation(operation)) {
        continue;
      }
      collector.add({
        deprecated: operation.deprecated ?? false,
        description: operation.description ?? "",
        key: operationKey(method, path, operation.operationId),
        method,
        operationId: operation.operationId,
        path,
        summary: operation.summary ?? "",
        tag: operation.tags?.[0] ?? UNTAGGED,
      });
    }
  }

  return { ...collector.finish(), warnings };
};

/** Resolve the operation object for a ref out of its (OpenAPI) document. */
export const operationObject = (
  spec: ApiSpecData,
  ref: ApiOperationRef
): OperationObject | undefined => {
  // Only OpenAPI refs carry HTTP methods; the AsyncAPI counterpart is
  // `asyncApiOperationObject` in `asyncapi.ts`.
  const method = HTTP_METHODS.find((candidate) => candidate === ref.method);
  // SAFETY: only OpenAPI specs route their refs through this resolver
  // (AsyncAPI documents go to `asyncApiOperationObject`), so the spec's
  // document is the OpenAPI shape.
  const document = spec.document as ApiDocument;
  const item = document.paths?.[ref.path];
  const operation = method === undefined ? undefined : item?.[method];
  return isOperation(operation) ? operation : undefined;
};

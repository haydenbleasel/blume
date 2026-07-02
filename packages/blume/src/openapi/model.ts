import type {
  Document,
  OperationObject,
  PathItemObject,
} from "@scalar/openapi-types/3.1";

/**
 * Blume's own OpenAPI model. Specs are parsed and upgraded to 3.1 (see
 * `parse.ts`) with internal `$ref`s left intact — the document stays
 * JSON-serializable (a fully dereferenced graph can be circular), and the schema
 * components resolve refs against `document.components.schemas` at render time.
 * Each operation is flattened into an {@link ApiOperationRef} with a real,
 * per-operation route so it becomes a first-class Blume page.
 */

/** A normalized OpenAPI 3.1 document, internal `$ref`s intact. */
export type ApiDocument = Document;

const NON_SLUG = /[^a-z0-9]+/gu;
const SLUG_EDGES = /^-+|-+$/gu;

/** Lowercase, URL-safe slug: `Add a Pet!` -> `add-a-pet`. */
export const slugify = (text: string): string =>
  text.toLowerCase().replace(NON_SLUG, "-").replace(SLUG_EDGES, "");

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

/** One operation, flattened out of the paths object and mapped to a route. */
export interface ApiOperationRef {
  /** Stable key, unique within a spec; matches the MDX `<Operation id>`. */
  key: string;
  method: HttpMethod;
  /** Templated path, e.g. `/pets/{id}`. */
  path: string;
  /** Full site route for this operation's page, e.g. `/reference/pet/add-pet`. */
  route: string;
  /** Display tag name (first tag, or `Operations` when untagged). */
  tag: string;
  tagSlug: string;
  summary: string;
  description: string;
  operationId?: string;
  deprecated: boolean;
}

/** A tag/section, in first-seen order. */
export interface ApiTagRef {
  slug: string;
  name: string;
  description: string;
}

/** Everything the runtime needs for one spec, serialized into `blume:openapi`. */
export interface ApiSpecData {
  /** Unique token used as the `<Operation source>` and the data-module key. */
  slug: string;
  /** Base route the spec's operations hang off, e.g. `/reference`. */
  route: string;
  label: string;
  title: string;
  version: string;
  description: string;
  document: ApiDocument;
  /** Operations keyed by {@link ApiOperationRef.key}. */
  operations: Record<string, ApiOperationRef>;
  tags: ApiTagRef[];
  /** Code-sample languages to render per operation. */
  codeSamples: string[];
  /** Whether nested schema rows start expanded. */
  expandSchemas: boolean;
}

/** The generated `blume:openapi` module: specs keyed by {@link ApiSpecData.slug}. */
export type OpenApiData = Record<string, ApiSpecData>;

const isOperation = (value: unknown): value is OperationObject =>
  typeof value === "object" && value !== null;

/**
 * Flatten a 3.1 document into a route-mapped operation list and its ordered
 * tags. Operations inherit the first tag they declare; keys are de-duplicated so
 * a repeated `operationId` still yields distinct routes.
 */
export const extractOperations = (
  document: ApiDocument,
  baseRoute: string
): { operations: ApiOperationRef[]; tags: ApiTagRef[] } => {
  const operations: ApiOperationRef[] = [];
  const tagOrder: string[] = [];
  const tagMeta = new Map(
    (document.tags ?? []).map((tag) => [tag.name, tag.description ?? ""])
  );
  const seen = new Set<string>();

  for (const [path, rawItem] of Object.entries(document.paths ?? {})) {
    const item = rawItem as PathItemObject | undefined;
    if (!item || "$ref" in item) {
      continue;
    }
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isOperation(operation)) {
        continue;
      }
      const tag = operation.tags?.[0] ?? UNTAGGED;
      const tagSlug = slugify(tag) || "operations";
      if (!tagOrder.includes(tag)) {
        tagOrder.push(tag);
      }
      let key = operationKey(method, path, operation.operationId);
      while (seen.has(key)) {
        key = `${key}-${method}`;
      }
      seen.add(key);
      operations.push({
        deprecated: operation.deprecated ?? false,
        description: operation.description ?? "",
        key,
        method,
        operationId: operation.operationId,
        path,
        route: `${baseRoute}/${tagSlug}/${key}`,
        summary: operation.summary ?? "",
        tag,
        tagSlug,
      });
    }
  }

  const tags: ApiTagRef[] = tagOrder.map((name) => ({
    description: tagMeta.get(name) ?? "",
    name,
    slug: slugify(name) || "operations",
  }));

  return { operations, tags };
};

/** Resolve the operation object for a ref out of its document. */
export const operationObject = (
  spec: ApiSpecData,
  ref: ApiOperationRef
): OperationObject | undefined => {
  const item = (spec.document.paths?.[ref.path] ?? undefined) as
    | PathItemObject
    | undefined;
  const operation = item?.[ref.method];
  return isOperation(operation) ? operation : undefined;
};

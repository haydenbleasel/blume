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

// Keep Unicode letters/numbers so diacritics stay in the slug. ASCII-only
// stripping turned `Größe` into `gr-e`, and the nav humanizer then rendered
// that as `Gr E`.
const NON_SLUG = /[^\p{L}\p{M}\p{N}]+/gu;
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
 * Assign each distinct tag name a unique slug. `slugify` can collapse
 * different names onto one value — any two punctuation-only tags (`!!!`,
 * `???`) both fall through to the `operations` fallback — and a shared slug
 * silently merges the tags' routes, sidebar groups, and overview sections.
 * Collisions gain `-2`, `-3`, … in first-seen order.
 */
const tagSlugger = (): ((name: string) => string) => {
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

/**
 * Flatten a 3.1 document into a route-mapped operation list and its ordered
 * tags. Operations inherit the first tag they declare; keys are de-duplicated so
 * a repeated `operationId` still yields distinct routes. `warnings` reports
 * anything skipped (a `$ref` path item), so missing operations aren't silent.
 */
export const extractOperations = (
  document: ApiDocument,
  baseRoute: string
): { operations: ApiOperationRef[]; tags: ApiTagRef[]; warnings: string[] } => {
  const operations: ApiOperationRef[] = [];
  const tagOrder: string[] = [];
  const tagsSeen = new Set<string>();
  const tagMeta = new Map(
    (document.tags ?? []).map((tag) => [tag.name, tag.description ?? ""])
  );
  const seen = new Set<string>();
  const warnings: string[] = [];
  const slugForTag = tagSlugger();

  for (const [path, rawItem] of Object.entries(document.paths ?? {})) {
    const item = rawItem as PathItemObject | undefined;
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
      const tag = operation.tags?.[0] ?? UNTAGGED;
      const tagSlug = slugForTag(tag);
      if (!tagsSeen.has(tag)) {
        tagsSeen.add(tag);
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
        // A root-mounted reference (`route: "/"`) must not emit `//tag/key`.
        route: `${baseRoute === "/" ? "" : baseRoute}/${tagSlug}/${key}`,
        summary: operation.summary ?? "",
        tag,
        tagSlug,
      });
    }
  }

  const tags: ApiTagRef[] = tagOrder.map((name) => ({
    description: tagMeta.get(name) ?? "",
    name,
    // The same slugger instance, so every tag resolves to the slug its
    // operations were routed under.
    slug: slugForTag(name),
  }));

  return { operations, tags, warnings };
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

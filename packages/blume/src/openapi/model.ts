import type { Document, OperationObject } from "@scalar/openapi-types/3.2";

import type { UIStrings } from "../core/i18n-ui.ts";
import type { GraphqlAuthOptions } from "../reference/options.ts";
import type {
  AsyncApiAction,
  AsyncApiDocument,
  AsyncApiSpecValue,
} from "./asyncapi.ts";
// Type-only, so the import can't cycle at runtime (checks.ts and graphql.ts
// import from here).
import type { SpecIssue } from "./checks.ts";
import type { GraphqlDocument, GraphqlMember } from "./graphql.ts";
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

/**
 * A normalized OpenAPI document, internal `$ref`s intact. Typed as 3.2, which
 * is backward compatible with 3.1, so one type covers both the upgraded 3.1
 * documents and the 3.2 ones read as written.
 */
export type ApiDocument = Document;

/**
 * The HTTP methods an OpenAPI path item may declare, in spec order. `query`
 * is OpenAPI 3.2's (the QUERY method: a safe request that carries a body); a
 * 3.1 path item can't declare it, so listing it changes nothing there.
 */
export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "query",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Group used for operations that declare no tag. */
const UNTAGGED = "Operations";

/** Group used for webhooks that declare no tag. */
const UNTAGGED_WEBHOOKS = "Webhooks";

/**
 * The site's words for those two groups. Their slugs stay the English names
 * above, so a translation never moves a page.
 */
export type UntaggedStrings = Pick<
  UIStrings["reference"],
  "operations" | "webhooks"
>;

/** A lower-case letter or digit followed by a capital: `addPet`, `v2List`. */
const CASE_BOUNDARY = /(?<before>[\p{Ll}\p{N}])(?<capital>\p{Lu})/gu;
/** The last capital of an acronym before a capitalized word: `HTTPResponse`. */
const ACRONYM_BOUNDARY = /(?<acronym>\p{Lu})(?<word>\p{Lu}\p{Ll})/gu;

/**
 * Hyphenate an identifier's word boundaries before slugifying, so a camelCase
 * `operationId` keeps its words in the URL (`getHTTPResponse` ->
 * `get-http-response`) instead of collapsing once `slugify` lowercases it.
 * OpenAPI generators reuse operation ids as SDK method names, so camelCase is
 * the norm there; GraphQL field and type names and AsyncAPI operation ids go
 * through the same rule so every spec kind derives routes alike. An id that
 * is already kebab-case has no boundaries to split and passes through as is.
 */
const splitIdentifier = (identifier: string): string =>
  identifier
    .replace(CASE_BOUNDARY, "$<before>-$<capital>")
    .replace(ACRONYM_BOUNDARY, "$<acronym>-$<word>");

/** A stable, URL-safe key for an operation: its `operationId`, else method+path. */
export const operationKey = (
  method: string,
  path: string,
  operationId?: string
): string => {
  const fromId = operationId ? slugify(splitIdentifier(operationId)) : "";
  return fromId || slugify(`${method}-${path}`);
};

/** One operation, flattened out of its document and mapped to a route. */
export interface ApiOperationRef {
  /** Stable key, unique within a spec; matches the MDX `<Operation id>`. */
  key: string;
  /**
   * HTTP method (OpenAPI), `send`/`receive` action (AsyncAPI), or the member
   * kind — a root-field operation kind or a named-type kind (GraphQL).
   */
  method: HttpMethod | AsyncApiAction | GraphqlMember;
  /**
   * Templated path, e.g. `/pets/{id}` — the channel address (AsyncAPI), or
   * the root field / type name (GraphQL).
   */
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
  /**
   * An OpenAPI 3.1 webhook: a request the API sends to the reader's endpoint
   * rather than one it serves. `path` then holds the webhook's name, the key
   * it has under the document's `webhooks`.
   */
  webhook?: true;
}

/**
 * A tag/section: the spec's declared tags in their declared order, then any
 * undeclared tag an operation uses, in first-seen order.
 */
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
  document: ApiDocument | AsyncApiDocument | GraphqlDocument;
  /**
   * URL of the live GraphQL endpoint the playground and code samples target
   * (GraphQL only; OpenAPI documents carry their servers in the document).
   */
  endpoint?: string;
  /** How the GraphQL endpoint authenticates (GraphQL only). */
  auth?: GraphqlAuthOptions;
  /** Operations keyed by {@link ApiOperationRef.key}. */
  operations: Record<string, ApiOperationRef>;
  tags: ApiTagRef[];
  /** Code-sample languages to render per operation; `false` for none. */
  codeSamples: string[] | false;
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

/**
 * The spec a `<Operation source>` / `<ApiOverview source>` names, or nothing.
 * `blume:openapi` crosses a JSON boundary as a plain object, so a lookup must
 * be an own-property one: `source="toString"` would otherwise resolve to the
 * inherited function, which is truthy and carries no `operations`, and every
 * consumer would throw where it means to decline. Shared by the components
 * and the agent-surface serializers so they miss the same way.
 */
export const specOf = (
  specs: OpenApiData,
  source: string
): ApiSpecData | undefined =>
  Object.hasOwn(specs, source) ? specs[source] : undefined;

/** The operation an `<Operation id>` names within its spec, or nothing. */
export const operationOf = (
  spec: ApiSpecData,
  id: string
): ApiOperationRef | undefined =>
  Object.hasOwn(spec.operations, id) ? spec.operations[id] : undefined;

/** The addresses an API overview lists, and what to call them. */
export interface SpecAddresses {
  /** `Base URL` (OpenAPI), `Servers` (AsyncAPI) or `Endpoint` (GraphQL). */
  label: string;
  addresses: string[];
}

/**
 * Where the API lives, flattened into one list for the overview page. OpenAPI
 * declares `servers` as an array of URLs; AsyncAPI as a named map of
 * host/protocol/pathname; a GraphQL schema names no server, so its configured
 * live endpoint stands in.
 */
export const specAddresses = (spec: ApiSpecData): SpecAddresses => {
  const addresses: string[] = [];
  if (spec.kind === "graphql") {
    if (spec.endpoint) {
      addresses.push(spec.endpoint);
    }
    return { addresses, label: "Endpoint" };
  }
  if (spec.kind === "asyncapi") {
    // SAFETY: an `asyncapi` spec's document is the AsyncAPI shape (`parse.ts`
    // routes each kind to its own parser).
    const servers = (spec.document as AsyncApiDocument).servers ?? {};
    for (const server of Object.values(servers)) {
      if (server?.host) {
        addresses.push(
          `${server.protocol ? `${server.protocol}://` : ""}${server.host}${server.pathname ?? ""}`
        );
      }
    }
    return { addresses, label: "Servers" };
  }
  // Hand-written specs sometimes declare `servers` as a bare object; degrade
  // to no addresses instead of throwing mid-build.
  // SAFETY: the remaining kind is OpenAPI, whose document declares `servers`
  // as an array of server objects; the array check below guards a spec that
  // wrote something else there.
  const declared = (spec.document as { servers?: { url?: string }[] }).servers;
  for (const server of Array.isArray(declared) ? declared : []) {
    if (server.url) {
      addresses.push(server.url);
    }
  }
  return { addresses, label: "Base URL" };
};

const SERVER_VARIABLE = /\{(?<name>[^{}]+)\}/gu;

const isDocumentObject = (
  value: AsyncApiSpecValue
): value is Record<string, AsyncApiSpecValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// YAML reads an unquoted `default: 8443` as a number; it is still the port.
const isVariableDefault = (
  value: AsyncApiSpecValue
): value is string | number =>
  typeof value === "string" || typeof value === "number";

/**
 * A server URL template — an OpenAPI `servers[].url`, an AsyncAPI server's
 * `host` or `pathname` — with each `{variable}` replaced by the `default` its
 * `variables` map declares. Code samples, the playground's Send, and the
 * proxy allowlist all need a real address, and
 * `https://{region}.api.example.com` is not one. A variable the map doesn't
 * define with a default (invalid per both specs) stays templated.
 */
export const withServerDefaults = (
  template: string,
  variables: AsyncApiSpecValue
): string =>
  template.replaceAll(SERVER_VARIABLE, (match, name: string) => {
    const variable =
      isDocumentObject(variables) && Object.hasOwn(variables, name)
        ? variables[name]
        : undefined;
    const value = isDocumentObject(variable) ? variable.default : undefined;
    return isVariableDefault(value) ? String(value) : match;
  });

// The runtime object check stands guard because the document was parsed from
// arbitrary YAML/JSON: a spec can put a scalar where the type promises an
// operation object.
const isOperation = (
  value: OperationObject | undefined
): value is OperationObject => typeof value === "object" && value !== null;

/** Whether a spec value is text YAML may have read as a number. */
const isText = <Value>(value: Value): value is Value & (string | number) =>
  typeof value === "string" || typeof value === "number";

/**
 * A spec field that names something, as a string. YAML reads an unquoted
 * `operationId: 404` or `tags: [2024]` as a number, which still names the
 * operation or tag; anything else a hand-written spec puts there counts as
 * absent.
 */
const specText = <Value>(value: Value): string | undefined =>
  isText(value) ? String(value) : undefined;

/**
 * A tag's slug before collisions are resolved, its word boundaries hyphenated
 * the way an operation id's are (`InboxesThreads` -> `inboxes-threads`).
 */
const wordSlug = (name: string): string => slugify(splitIdentifier(name));

/**
 * Assign each distinct tag name a unique slug. `slugify` can collapse
 * different names onto one value — any two punctuation-only tags (`!!!`,
 * `???`) both fall through to the `operations` fallback — and a shared slug
 * silently merges the tags' routes, sidebar groups, and overview sections.
 * Collisions gain `-2`, `-3`, … in first-seen order. Shared with the AsyncAPI
 * extractor (`asyncapi.ts`), whose untagged fallback groups are channel
 * addresses. `slug` is the rule before collisions: the collector also runs
 * the one earlier releases used (`slugify` alone, so `InboxesThreads` ->
 * `inboxesthreads`) to redirect the routes they gave.
 */
export const tagSlugger = (
  slug: (name: string) => string = wordSlug
): ((name: string) => string) => {
  const assigned = new Map<string, string>();
  const taken = new Set<string>();
  return (name) => {
    const existing = assigned.get(name);
    if (existing) {
      return existing;
    }
    const base = slug(name) || "operations";
    let unique = base;
    for (let suffix = 2; taken.has(unique); suffix += 1) {
      unique = `${base}-${suffix}`;
    }
    taken.add(unique);
    assigned.set(name, unique);
    return unique;
  };
};

/**
 * How a warning names an operation: `GET /pets`, or a webhook by its name
 * (`Webhook "newPet" (POST)`), since a webhook has no path.
 */
export const operationLabel = (
  name: string,
  method: string,
  webhook: boolean
): string =>
  webhook
    ? `Webhook "${name}" (${method.toUpperCase()})`
    : `${method.toUpperCase()} ${name}`;

/** One entry of a document's `paths` or `webhooks` map. */
type PathItemEntry =
  | NonNullable<ApiDocument["paths"]>[string]
  | NonNullable<ApiDocument["webhooks"]>[string];

/** An operation before the collector assigns its unique key and route. */
type CollectedOperation = Omit<ApiOperationRef, "route" | "tagSlug">;

/** What a spec's `tags` list says about one tag. */
export interface ApiTagMeta {
  description: string;
  /**
   * The tag's label, in place of its name, from Redocly's `x-displayName`
   * extension. Only the label changes: the tag's slug, and so its routes,
   * still come from its name.
   */
  displayName?: string;
}

/**
 * A route an earlier release gave an operation's page, and the route the
 * page has now: the source turns each into a redirect, so links to the old
 * URL keep working.
 */
export interface MovedRoute {
  from: string;
  to: string;
}

/** The flattened output both extractors produce. */
export interface CollectedOperations {
  operations: ApiOperationRef[];
  tags: ApiTagRef[];
  /** Operation routes that moved from what earlier slug rules gave them. */
  moved: MovedRoute[];
}

/** The collector handle: feed operations in, read the flattened output out. */
export interface OperationCollector {
  /** Add an operation, returning it with its key and route assigned. */
  add: (entry: CollectedOperation) => ApiOperationRef;
  finish: () => CollectedOperations;
}

/** {@link CollectedOperations} plus anything the extractor had to skip. */
export interface ExtractedOperations extends CollectedOperations {
  warnings: string[];
}

/**
 * The collector behind both extractors (OpenAPI here, AsyncAPI in
 * `asyncapi.ts`): declared-then-first-seen tag ordering, key de-duplication
 * (a repeated key gains its method/action as a suffix), and the shared route
 * template — so URL shape and slug rules can never drift between the two spec
 * kinds.
 *
 * A key is unique across the spec, since it names the operation in
 * `<Operation id>`. Its page's URL only has to be unique within its tag's
 * folder, so the last route segment de-duplicates per tag: `list` in two
 * tags is `/pets/list` and `/stores/list`, not `/stores/list-get`. Earlier
 * releases de-duplicated the route like the key, and slugged tags without
 * splitting their words; each route those rules gave differently is
 * reported in `moved`.
 *
 * `names` labels the groups Blume names itself (untagged operations,
 * GraphQL's kinds) in the site's language; like `x-displayName`, it changes
 * only the label, so their slugs, and routes, stay the same in every language.
 */
export const operationCollector = (
  baseRoute: string,
  tagMeta: ReadonlyMap<string, ApiTagMeta>,
  names: ReadonlyMap<string, string> = new Map()
): OperationCollector => {
  const operations: ApiOperationRef[] = [];
  const moved: MovedRoute[] = [];
  const tagOrder: string[] = [];
  const tagsSeen = new Set<string>();
  const seen = new Set<string>();
  // Tag slug -> the route segments its operations took.
  const segments = new Map<string, Set<string>>();
  const slugForTag = tagSlugger();
  const legacySlugForTag = tagSlugger(slugify);
  // A root-mounted reference (`route: "/"`) must not emit `//tag/key`.
  const base = baseRoute === "/" ? "" : baseRoute;
  const label = (name: string): string =>
    tagMeta.get(name)?.displayName ?? names.get(name) ?? name;

  const add = (entry: CollectedOperation): ApiOperationRef => {
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
    const taken = segments.get(tagSlug) ?? new Set<string>();
    segments.set(tagSlug, taken);
    let segment = entry.key;
    while (taken.has(segment)) {
      segment = `${segment}-${entry.method}`;
    }
    taken.add(segment);
    const route = `${base}/${tagSlug}/${segment}`;
    const legacy = `${base}/${legacySlugForTag(entry.tag)}/${key}`;
    if (legacy !== route) {
      moved.push({ from: legacy, to: route });
    }
    const operation: ApiOperationRef = {
      ...entry,
      key,
      route,
      tag: label(entry.tag),
      tagSlug,
    };
    operations.push(operation);
    return operation;
  };

  // Declared tags in the order the spec's `tags` list gives them, then any
  // tag an operation uses without declaring it, in first-use order. The
  // declared order is the author's section order, not an accident of which
  // path happens to come first.
  const declared = [...tagMeta.keys()];
  const rank = (name: string): number => {
    const index = declared.indexOf(name);
    return index === -1 ? declared.length : index;
  };

  const finish = (): CollectedOperations => ({
    moved,
    operations,
    tags: tagOrder
      .toSorted((a, b) => rank(a) - rank(b))
      .map((name) => ({
        description: tagMeta.get(name)?.description ?? "",
        name: label(name),
        // The same slugger instance, so every tag resolves to the slug its
        // operations were routed under.
        slug: slugForTag(name),
      })),
  });

  return { add, finish };
};

/** {@link ExtractedOperations} plus the spec mistakes extraction noticed. */
export interface ExtractedApiOperations extends ExtractedOperations {
  issues: SpecIssue[];
}

/** A spec's `tags` as the collector reads them: name -> description and label. */
const declaredTags = (document: ApiDocument): Map<string, ApiTagMeta> =>
  new Map(
    (document.tags ?? []).flatMap((tag): [string, ApiTagMeta][] => {
      const name = specText(tag.name);
      if (name === undefined) {
        return [];
      }
      const meta: ApiTagMeta = { description: tag.description ?? "" };
      const displayName = specText(tag["x-displayName"]);
      if (displayName) {
        meta.displayName = displayName;
      }
      return [[name, meta]];
    })
  );

/**
 * Flatten a 3.1 document into a route-mapped operation list and its ordered
 * tags, webhooks included. Operations inherit the first tag they declare; keys
 * are de-duplicated so a repeated `operationId` still yields distinct routes,
 * with an issue naming both operations. `warnings` reports anything skipped (a
 * `$ref` path item), so missing operations aren't silent.
 *
 * Operations come out in the spec's order: paths as listed, and each path's
 * methods as written. They're keyed in the method order earlier releases
 * walked (`HTTP_METHODS`), so a repeated id resolves to the same key, and
 * the same route, it always did. `strings` labels the untagged groups in the
 * site's language; without it they keep their English names.
 */
export const extractOperations = (
  document: ApiDocument,
  baseRoute: string,
  strings?: UntaggedStrings
): ExtractedApiOperations => {
  const warnings: string[] = [];
  const issues: SpecIssue[] = [];
  const tags = declaredTags(document);
  // The untagged groups take the site's words; a tag the spec declares keeps
  // the name it was given, even one called `Operations`.
  const names = new Map<string, string>();
  if (strings && !tags.has(UNTAGGED)) {
    names.set(UNTAGGED, strings.operations);
  }
  if (strings && !tags.has(UNTAGGED_WEBHOOKS)) {
    names.set(UNTAGGED_WEBHOOKS, strings.webhooks);
  }
  const collector = operationCollector(baseRoute, tags, names);
  // Each operation's place in the spec, and the first operation to declare
  // each operationId.
  const position = new Map<ApiOperationRef, number>();
  const firstWithId = new Map<string, string>();
  let cursor = 0;

  // A path item's operations, filed under `name`: a path for `paths`, the
  // webhook's key for `webhooks`.
  const addPathItem = (
    name: string,
    item: PathItemEntry,
    webhook: boolean
  ): void => {
    // A parsed spec can carry a null path item despite the type; skip it.
    if (!item) {
      return;
    }
    if ("$ref" in item) {
      warnings.push(
        webhook
          ? `Webhook "${name}" is a $ref to a shared path item; referenced path items are not resolved, so it is missing from the reference. Inline the path item under "webhooks" to render it.`
          : `Path "${name}" is a $ref to a shared path item; referenced path items are not resolved, so its operations are missing from the reference. Inline the path item under "paths" to render it.`
      );
      return;
    }
    const written = Object.keys(item);
    const offset = cursor;
    cursor += written.length;
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isOperation(operation)) {
        continue;
      }
      const operationId = specText(operation.operationId);
      const entry: CollectedOperation = {
        deprecated: operation.deprecated ?? false,
        description: specText(operation.description) ?? "",
        // A webhook without an operationId is keyed by its name, which is
        // already an identifier (`newPet` -> `new-pet`).
        key: operationKey(
          method,
          name,
          operationId ?? (webhook ? name : undefined)
        ),
        method,
        operationId,
        path: name,
        summary: specText(operation.summary) ?? "",
        tag:
          specText(operation.tags?.[0]) ??
          (webhook ? UNTAGGED_WEBHOOKS : UNTAGGED),
      };
      const added = collector.add(
        webhook ? { ...entry, webhook: true } : entry
      );
      position.set(added, offset + written.indexOf(method));
      if (operationId === undefined) {
        continue;
      }
      const label = operationLabel(name, method, webhook);
      const first = firstWithId.get(operationId);
      if (first === undefined) {
        firstWithId.set(operationId, label);
        continue;
      }
      // The key always gains a suffix; the URL only when the two share a tag.
      const url = added.route.endsWith(`/${entry.key}`)
        ? ""
        : ` and serves its page at ${added.route}`;
      issues.push({
        code: "BLUME_OPENAPI_DUPLICATE_OPERATION_ID",
        message: `${first} and ${label} share the operationId "${operationId}", which must be unique in a spec, so Blume names the second one "${added.key}" in \`<Operation id>\`${url}.`,
        suggestion: `Give each operation its own operationId.`,
      });
    }
  };

  for (const [path, item] of Object.entries(document.paths ?? {})) {
    addPathItem(path, item, false);
  }
  // OpenAPI 3.1 webhooks: requests the API sends rather than serves. They
  // follow the paths, so an untagged webhook group sits after the endpoints.
  for (const [name, item] of Object.entries(document.webhooks ?? {})) {
    addPathItem(name, item, true);
  }

  const collected = collector.finish();
  return {
    ...collected,
    issues,
    // `position` holds every operation the collector added.
    operations: collected.operations.toSorted(
      (a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0)
    ),
    warnings,
  };
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
  const item = ref.webhook
    ? document.webhooks?.[ref.path]
    : document.paths?.[ref.path];
  const operation = method === undefined ? undefined : item?.[method];
  return isOperation(operation) ? operation : undefined;
};

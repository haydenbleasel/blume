import type { ApiOperationRef, ApiTagRef } from "./model.ts";
import { tagSlugger } from "./model.ts";
import { slugify } from "./references.ts";

/**
 * Blume's own AsyncAPI model — the second front-end of the API reference
 * pipeline. Specs are normalized to AsyncAPI 3.x at parse time (see
 * `parseAsyncApiSpec` in `parse.ts`), so this module only handles one shape:
 * top-level `operations` with `action: send | receive` pointing at `channels`.
 * Internal `$ref`s are deliberately left in place, mirroring `model.ts` — the
 * components resolve them lazily, which keeps circular schemas serializable
 * and lets type labels keep their `#/components/schemas/<name>` names.
 * Browser-safe: no Node imports (the components import from here).
 */

/** The two AsyncAPI 3.x operation actions, from the application's perspective. */
export const ASYNCAPI_ACTIONS = ["send", "receive"] as const;

export type AsyncApiAction = (typeof ASYNCAPI_ACTIONS)[number];

/** A permissive view of an AsyncAPI reference object. */
export interface AsyncApiRefLike {
  $ref?: string;
  [key: string]: unknown;
}

/** A permissive view of an AsyncAPI 3.x channel — only the fields we render. */
export interface AsyncApiChannelObject {
  address?: string | null;
  title?: string;
  summary?: string;
  description?: string;
  messages?: Record<string, AsyncApiRefLike>;
  parameters?: Record<string, AsyncApiRefLike>;
  servers?: AsyncApiRefLike[];
  bindings?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** A permissive view of an AsyncAPI 3.x operation — only the fields we render. */
export interface AsyncApiOperationObject {
  action?: string;
  channel?: AsyncApiRefLike;
  title?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  tags?: { name?: string; description?: string }[];
  security?: AsyncApiRefLike[];
  messages?: AsyncApiRefLike[];
  bindings?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** A permissive view of an AsyncAPI 3.x server object. */
export interface AsyncApiServerObject {
  host?: string;
  protocol?: string;
  pathname?: string;
  description?: string;
  security?: AsyncApiRefLike[];
  [key: string]: unknown;
}

/** A normalized AsyncAPI 3.x document, internal `$ref`s intact. */
export interface AsyncApiDocument {
  asyncapi?: string;
  info?: {
    title?: string;
    version?: string;
    description?: string;
    tags?: { name?: string; description?: string }[];
    [key: string]: unknown;
  };
  defaultContentType?: string;
  servers?: Record<string, AsyncApiServerObject>;
  channels?: Record<string, AsyncApiChannelObject>;
  operations?: Record<string, AsyncApiOperationObject>;
  components?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** Decode a JSON-pointer token: `user~1signedup` -> `user/signedup`. */
const unescapePointer = (token: string): string =>
  token.replaceAll("~1", "/").replaceAll("~0", "~");

const CHANNEL_REF = /^#\/channels\/(?<id>.+)$/u;

/** The channel id an operation's `channel.$ref` points at, if resolvable. */
export const channelIdOf = (channel?: AsyncApiRefLike): string | undefined => {
  const id = CHANNEL_REF.exec(channel?.$ref ?? "")?.groups?.id;
  return id === undefined ? undefined : unescapePointer(id);
};

/**
 * A channel's display address. AsyncAPI 3.x allows `address: null` (unknown at
 * design time) — fall back to the channel id so the operation still shows
 * where it lives.
 */
export const channelAddress = (
  channelId: string,
  channel?: AsyncApiChannelObject
): string =>
  typeof channel?.address === "string" && channel.address !== ""
    ? channel.address
    : channelId;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const TRAIT_REF =
  /^#\/components\/(?<section>operationTraits|messageTraits)\/(?<name>[^/]+)$/u;

/**
 * Merge `traits` into their operation/message objects, in declaration order,
 * with the object's own properties taking precedence (the spec's merge rule;
 * applied shallowly, which covers the fields traits carry in practice —
 * bindings, security, tags, headers). Runs once at parse time so the
 * serialized document and every downstream consumer are trait-free; the
 * `traits` key itself is dropped. Unresolvable trait `$ref`s are skipped.
 */
export const applyAsyncApiTraits = (
  document: AsyncApiDocument
): AsyncApiDocument => {
  const resolveTrait = (
    trait: unknown
  ): Record<string, unknown> | undefined => {
    if (!isObject(trait)) {
      return undefined;
    }
    if (typeof trait.$ref !== "string") {
      return trait;
    }
    const groups = TRAIT_REF.exec(trait.$ref)?.groups;
    const section = groups?.section
      ? document.components?.[groups.section]
      : undefined;
    const resolved = section?.[groups?.name ?? ""];
    return isObject(resolved) ? resolved : undefined;
  };

  const mergeTraits = (node: Record<string, unknown>): void => {
    const { traits } = node;
    if (!Array.isArray(traits)) {
      return;
    }
    delete node.traits;
    const merged: Record<string, unknown> = {};
    for (const trait of traits) {
      Object.assign(merged, resolveTrait(trait));
    }
    for (const [key, value] of Object.entries(merged)) {
      if (!(key in node)) {
        node[key] = value;
      }
    }
  };

  for (const operation of Object.values(document.operations ?? {})) {
    if (isObject(operation)) {
      mergeTraits(operation);
    }
  }
  const messageMaps = [
    ...Object.values(document.channels ?? {}).map((channel) =>
      isObject(channel) ? channel.messages : undefined
    ),
    document.components?.messages,
  ];
  for (const messages of messageMaps) {
    if (!isObject(messages)) {
      continue;
    }
    for (const message of Object.values(messages)) {
      // A channel message that is itself a `$ref` resolves to a components
      // message, which this loop also visits — don't merge through the ref.
      if (isObject(message) && typeof message.$ref !== "string") {
        mergeTraits(message);
      }
    }
  }
  return document;
};

/**
 * Resolve where one operation renders from: its action and its declared
 * channel. A string return is the warning explaining why the operation can't
 * appear in the reference.
 */
const operationSite = (
  id: string,
  operation: AsyncApiOperationObject,
  channels: Record<string, AsyncApiChannelObject>
): { action: AsyncApiAction; channelId: string; address: string } | string => {
  const action = ASYNCAPI_ACTIONS.find((a) => a === operation.action);
  if (!action) {
    return `Operation "${id}" declares no send/receive action; it is missing from the reference.`;
  }
  const channelId = channelIdOf(operation.channel);
  const channel = channelId === undefined ? undefined : channels[channelId];
  if (channelId === undefined || !isObject(channel)) {
    return `Operation "${id}" references a channel that isn't declared under "channels"; it is missing from the reference.`;
  }
  return { action, address: channelAddress(channelId, channel), channelId };
};

/**
 * Flatten a normalized AsyncAPI 3.x document into a route-mapped operation
 * list and its ordered tags — the AsyncAPI counterpart of `extractOperations`
 * in `model.ts`. Operations group by their
 * first tag; untagged operations fall back to their channel address, so a spec
 * with no tags still gets one sidebar group per channel. Keys come from the
 * operation id (the `operations` map key), which the official 2.x converter
 * synthesizes deterministically (`<channel>.publish` / `<channel>.subscribe`)
 * — so a 2.x spec and its converter-upgraded 3.x form yield identical URLs.
 */
export const extractAsyncApiOperations = (
  document: AsyncApiDocument,
  baseRoute: string
): { operations: ApiOperationRef[]; tags: ApiTagRef[]; warnings: string[] } => {
  const operations: ApiOperationRef[] = [];
  const tagOrder: string[] = [];
  const tagsSeen = new Set<string>();
  const tagMeta = new Map(
    (document.info?.tags ?? [])
      .filter((tag) => typeof tag?.name === "string")
      .map((tag) => [tag.name as string, tag.description ?? ""])
  );
  const seen = new Set<string>();
  const warnings: string[] = [];
  const slugForTag = tagSlugger();
  const channels = document.channels ?? {};

  for (const [id, operation] of Object.entries(document.operations ?? {})) {
    if (!isObject(operation)) {
      continue;
    }
    const site = operationSite(id, operation, channels);
    if (typeof site === "string") {
      warnings.push(site);
      continue;
    }
    const { action, address, channelId } = site;
    const tag = operation.tags?.find(
      (candidate) => typeof candidate?.name === "string"
    )?.name;
    const group = tag ?? address;
    const tagSlug = slugForTag(group);
    if (!tagsSeen.has(group)) {
      tagsSeen.add(group);
      tagOrder.push(group);
    }
    let key = slugify(id) || "operation";
    while (seen.has(key)) {
      key = `${key}-${action}`;
    }
    seen.add(key);
    operations.push({
      channelId,
      deprecated: operation.deprecated === true,
      description: operation.description ?? "",
      key,
      method: action,
      operationId: id,
      path: address,
      // A root-mounted reference (`route: "/"`) must not emit `//tag/key`.
      route: `${baseRoute === "/" ? "" : baseRoute}/${tagSlug}/${key}`,
      summary: operation.title ?? operation.summary ?? "",
      tag: group,
      tagSlug,
    });
  }

  const tags: ApiTagRef[] = tagOrder.map((name) => ({
    description: tagMeta.get(name) ?? "",
    name,
    // The same slugger instance, so every group resolves to the slug its
    // operations were routed under.
    slug: slugForTag(name),
  }));

  return { operations, tags, warnings };
};

/** Resolve the operation object for a ref out of its (AsyncAPI) document. */
export const asyncApiOperationObject = (
  document: AsyncApiDocument,
  ref: ApiOperationRef
): AsyncApiOperationObject | undefined => {
  const operation =
    ref.operationId === undefined
      ? undefined
      : document.operations?.[ref.operationId];
  return isObject(operation) ? operation : undefined;
};

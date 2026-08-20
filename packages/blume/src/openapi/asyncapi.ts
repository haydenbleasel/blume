import type { ApiOperationRef, ApiTagRef } from "./model.ts";
import { operationCollector, operationKey } from "./model.ts";

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

/**
 * A value carried by a parsed spec document: JSON-compatible data whose exact
 * position in the document is not modeled (extension fields, bindings,
 * protocol-specific extras). `undefined` covers absent optional members.
 */
export type AsyncApiSpecValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | AsyncApiSpecValue[]
  | { [key: string]: AsyncApiSpecValue };

/** A permissive view of an AsyncAPI reference object. */
export interface AsyncApiRefLike {
  $ref?: string;
  [key: string]: AsyncApiSpecValue;
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
  bindings?: Record<string, Record<string, AsyncApiSpecValue>>;
  [key: string]: AsyncApiSpecValue;
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
  bindings?: Record<string, Record<string, AsyncApiSpecValue>>;
  [key: string]: AsyncApiSpecValue;
}

/** A permissive view of an AsyncAPI 3.x server object. */
export interface AsyncApiServerObject {
  host?: string;
  protocol?: string;
  pathname?: string;
  description?: string;
  security?: AsyncApiRefLike[];
  [key: string]: AsyncApiSpecValue;
}

/** A normalized AsyncAPI 3.x document, internal `$ref`s intact. */
export interface AsyncApiDocument {
  asyncapi?: string;
  info?: {
    title?: string;
    version?: string;
    description?: string;
    tags?: { name?: string; description?: string }[];
    [key: string]: AsyncApiSpecValue;
  };
  defaultContentType?: string;
  servers?: Record<string, AsyncApiServerObject>;
  channels?: Record<string, AsyncApiChannelObject>;
  operations?: Record<string, AsyncApiOperationObject>;
  components?: Record<string, Record<string, AsyncApiSpecValue>>;
  [key: string]: AsyncApiSpecValue;
}

/** Decode a JSON-pointer token: `user~1signedup` -> `user/signedup`. */
const unescapePointer = (token: string): string =>
  token.replaceAll("~1", "/").replaceAll("~0", "~");

const CHANNEL_REF = /^#\/channels\/(?<id>.+)$/u;

const isString = (value: AsyncApiSpecValue): value is string =>
  typeof value === "string";

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
): string => {
  const address = channel?.address;
  return isString(address) && address !== "" ? address : channelId;
};

const isObject = (
  value: AsyncApiSpecValue
): value is Record<string, AsyncApiSpecValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const COMPONENT_SECTION_REF =
  /^#\/components\/(?<section>channels|operations)\/(?<name>[^/]+)$/u;

/**
 * Inline top-level `channels`/`operations` entries declared as Reference
 * Objects (`{ $ref: "#/components/channels/…" }` — the spec's reuse pattern)
 * by replacing them with their components target. Runs before trait merging
 * so an inlined operation's traits merge exactly like an inline one's.
 * Unresolvable refs stay in place; the extractor reports them.
 */
const inlineComponentRefs = (document: AsyncApiDocument): void => {
  const maps: [Record<string, AsyncApiSpecValue> | undefined, string][] = [
    [document.channels, "channels"],
    [document.operations, "operations"],
  ];
  for (const [map, section] of maps) {
    if (!isObject(map)) {
      continue;
    }
    const table = document.components?.[section];
    for (const [id, entry] of Object.entries(map)) {
      if (!isObject(entry) || !isString(entry.$ref)) {
        continue;
      }
      const groups = COMPONENT_SECTION_REF.exec(entry.$ref)?.groups;
      if (groups?.section !== section) {
        continue;
      }
      const resolved = isObject(table)
        ? table[unescapePointer(groups.name ?? "")]
        : undefined;
      if (isObject(resolved) && !isString(resolved.$ref)) {
        map[id] = resolved;
      }
    }
  }
};

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
    trait: AsyncApiSpecValue
  ): Record<string, AsyncApiSpecValue> | undefined => {
    if (!isObject(trait)) {
      return undefined;
    }
    if (!isString(trait.$ref)) {
      return trait;
    }
    const groups = TRAIT_REF.exec(trait.$ref)?.groups;
    const section = groups?.section
      ? document.components?.[groups.section]
      : undefined;
    const resolved = section?.[groups?.name ?? ""];
    return isObject(resolved) ? resolved : undefined;
  };

  const mergeTraits = (node: Record<string, AsyncApiSpecValue>): void => {
    const { traits } = node;
    if (!Array.isArray(traits)) {
      return;
    }
    delete node.traits;
    const merged: Record<string, AsyncApiSpecValue> = {};
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
  const channelMaps = [
    ...Object.values(document.channels ?? {}),
    // Reusable channels under components carry messages too; their traits
    // must merge the same way so a resolved component channel renders alike.
    ...Object.values(document.components?.channels ?? {}),
  ];
  const messageMaps = [
    ...channelMaps.map((channel) =>
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
      if (isObject(message) && !isString(message.$ref)) {
        mergeTraits(message);
      }
    }
  }
  return document;
};

/**
 * The parse-time normalization pass: component channel/operation refs inlined,
 * then traits merged. The serialized document and every downstream consumer
 * see plain channel/operation objects, trait-free.
 */
export const normalizeAsyncApiDocument = (
  document: AsyncApiDocument
): AsyncApiDocument => {
  inlineComponentRefs(document);
  return applyAsyncApiTraits(document);
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
  // A channel entry that is still a bare `$ref` survived normalization — its
  // components target doesn't exist — so it renders nothing useful either.
  if (channelId === undefined || !isObject(channel) || isString(channel.$ref)) {
    return `Operation "${id}" references a channel that isn't declared under "channels"; it is missing from the reference.`;
  }
  return { action, address: channelAddress(channelId, channel), channelId };
};

/** The route-mapped operations, ordered tags, and skip warnings of one document. */
export interface AsyncApiOperationCatalog {
  operations: ApiOperationRef[];
  tags: ApiTagRef[];
  warnings: string[];
}

/**
 * Flatten a normalized AsyncAPI 3.x document into a route-mapped operation
 * list and its ordered tags — the AsyncAPI counterpart of `extractOperations`
 * in `model.ts`, built on the same `operationCollector`. Operations group by
 * their first tag; untagged operations fall back to their channel address, so
 * a spec with no tags still gets one sidebar group per channel. Keys come from
 * the operation id (the `operations` map key), which the official 2.x
 * converter synthesizes deterministically (`<channel>.publish` /
 * `<channel>.subscribe`) — so a 2.x spec and its converter-upgraded 3.x form
 * yield identical URLs. An id that slugifies to nothing falls back to
 * action + address, the same scheme `operationKey` uses for method + path.
 */
export const extractAsyncApiOperations = (
  document: AsyncApiDocument,
  baseRoute: string
): AsyncApiOperationCatalog => {
  const warnings: string[] = [];
  const tagMeta = new Map(
    (document.info?.tags ?? [])
      .filter(
        (tag): tag is { name: string; description?: string } =>
          typeof tag?.name === "string"
      )
      .map((tag): [string, string] => [tag.name, tag.description ?? ""])
  );
  const collector = operationCollector(baseRoute, tagMeta);
  const channels = document.channels ?? {};

  for (const [id, operation] of Object.entries(document.operations ?? {})) {
    if (!isObject(operation)) {
      continue;
    }
    // An operation entry still carrying a `$ref` is one normalization could
    // not inline; name the real problem instead of the missing-action one.
    if (isString(operation.$ref)) {
      warnings.push(
        `Operation "${id}" is a reference that doesn't resolve to a components operation; it is missing from the reference.`
      );
      continue;
    }
    const site = operationSite(id, operation, channels);
    if (isString(site)) {
      warnings.push(site);
      continue;
    }
    const { action, address, channelId } = site;
    const tag = operation.tags?.find(
      (candidate): candidate is { name: string; description?: string } =>
        typeof candidate?.name === "string"
    )?.name;
    collector.add({
      channelId,
      deprecated: operation.deprecated === true,
      description: operation.description ?? "",
      key: operationKey(action, address, id),
      method: action,
      operationId: id,
      path: address,
      summary: operation.title ?? operation.summary ?? "",
      tag: tag ?? address,
    });
  }

  return { ...collector.finish(), warnings };
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

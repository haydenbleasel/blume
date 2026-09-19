import { z } from "zod";

import { asyncapiAdapterSchema } from "./asyncapi.ts";
import type { AsyncApiAdapter, ResolvedAsyncApiAdapter } from "./asyncapi.ts";
import { graphqlAdapterSchema } from "./graphql.ts";
import type { GraphqlAdapter, ResolvedGraphqlAdapter } from "./graphql.ts";
import { openapiAdapterSchema } from "./openapi.ts";
import type { OpenApiAdapter, ResolvedOpenApiAdapter } from "./openapi.ts";
import { rendererRuntimeDeps } from "./scalar.ts";

/** Every descriptor a `blume/reference` factory can return. */
export type ReferenceAdapter =
  | AsyncApiAdapter
  | GraphqlAdapter
  | OpenApiAdapter;

/** What `config.reference` holds: each descriptor with its options resolved. */
export type ResolvedReferenceAdapter =
  | ResolvedAsyncApiAdapter
  | ResolvedGraphqlAdapter
  | ResolvedOpenApiAdapter;

/**
 * One configured reference adapter, as its factory returned it. Only `kind`
 * and `options` carry information — the metadata lists are validated for
 * shape, then re-derived from the resolved options so a descriptor that went
 * through JSON resolves to the same canonical metadata the factory ships.
 */
export const referenceAdapterSchema = z
  .discriminatedUnion("kind", [
    asyncapiAdapterSchema,
    graphqlAdapterSchema,
    openapiAdapterSchema,
  ])
  .transform((value): ResolvedReferenceAdapter => ({
    ...value,
    requiredSecrets: [],
    // GraphQL is always Blume-rendered, so it has no renderer to declare
    // a dependency; the other kinds carry their renderer's.
    runtimeDeps: rendererRuntimeDeps(
      value.kind === "graphql" ? undefined : value.options.renderer
    ),
  }));

const LIST_HINT =
  'reference is a list of adapters — e.g. `reference: [openapi({ spec }), asyncapi({ spec }), graphql({ spec, endpoint })]`, imported from "blume/reference".';

/**
 * `blume.config.reference`: the API references to render, in order. Unset
 * means none. A non-array fails with the list hint; element errors keep their
 * own messages.
 */
export const referenceConfigSchema = z
  .array(referenceAdapterSchema, {
    error: (issue) => (issue.code === "invalid_type" ? LIST_HINT : undefined),
  })
  .default([]);

/** The top-level keys the `reference` list replaced. */
const REMOVED_KEYS = ["asyncapi", "graphql", "openapi"] as const;

/**
 * The hint for a config still carrying the 1.x `openapi`/`asyncapi`/`graphql`
 * blocks, or `undefined` when none of the unrecognized keys is one of them
 * (so the default "unrecognized key" message applies). Wired into the config
 * object's error hook: the keys are gone from the schema, so without this a
 * migrating site would see only "Unrecognized key".
 */
export const removedReferenceKeysHint = (
  keys: string[]
): string | undefined => {
  const removed = REMOVED_KEYS.filter((key) => keys.includes(key));
  if (removed.length === 0) {
    return undefined;
  }
  const list = removed.map((key) => `\`${key}\``).join(", ");
  const factories = removed.map((key) => `${key}({ … })`).join(", ");
  return `The top-level ${list} config was replaced by \`reference\`, a list of adapters imported from "blume/reference": \`reference: [${factories}]\`. Each block's options move onto its factory unchanged (\`enabled\` is gone — an adapter in the list is enabled), and \`renderer: "scalar"\` with \`theme\`/\`scalar\` becomes \`renderer: scalar({ theme, …scalar })\`.`;
};

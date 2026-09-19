import { z } from "zod";

import { adapterDescriptorSchema } from "../../core/adapter.ts";
import { algolia, algoliaOptionsSchema } from "./algolia.ts";
import type { AlgoliaAdapter } from "./algolia.ts";
import { flexsearch, flexsearchOptionsSchema } from "./flexsearch.ts";
import type { FlexsearchAdapter } from "./flexsearch.ts";
import { mixedbread, mixedbreadOptionsSchema } from "./mixedbread.ts";
import type { MixedbreadAdapter } from "./mixedbread.ts";
import { oramaCloud, oramaCloudOptionsSchema } from "./orama-cloud.ts";
import type { OramaCloudAdapter } from "./orama-cloud.ts";
import { orama, oramaOptionsSchema } from "./orama.ts";
import type { OramaAdapter } from "./orama.ts";
import { pagefind, pagefindOptionsSchema } from "./pagefind.ts";
import type { PagefindAdapter } from "./pagefind.ts";
import type {
  KeylessSearchOptions,
  SearchAdapter,
  SearchAdapterMode,
} from "./types.ts";
import { typesense, typesenseOptionsSchema } from "./typesense.ts";
import type { TypesenseAdapter } from "./typesense.ts";

/** Every descriptor a factory can return. */
export type AnySearchAdapter =
  | AlgoliaAdapter
  | FlexsearchAdapter
  | MixedbreadAdapter
  | OramaAdapter
  | OramaCloudAdapter
  | PagefindAdapter
  | TypesenseAdapter;

/** The resolved form of `search: false`: search is disabled. */
export type NoneSearchAdapter = SearchAdapter<
  "none",
  "none",
  KeylessSearchOptions
>;

/** What `config.search.provider` resolves to: an adapter, or `none`. */
export type ResolvedSearchAdapter = AnySearchAdapter | NoneSearchAdapter;

/** Every adapter identity, including the resolved `none`. */
export type SearchAdapterKind = ResolvedSearchAdapter["kind"];

export const NONE_SEARCH_ADAPTER: NoneSearchAdapter = {
  kind: "none",
  mode: "none",
  options: {},
  requiredSecrets: [],
  runtimeDeps: [],
};

/**
 * The descriptor shape a factory returns: the shared adapter contract plus
 * the search-specific `mode`. Only `kind` and `options` carry information —
 * the metadata lists are validated for shape, then re-derived from the
 * factory below so a descriptor that went through JSON resolves to the same
 * canonical metadata Blume ships.
 */
const descriptor = <
  Kind extends string,
  Mode extends SearchAdapterMode,
  Options extends z.ZodType,
>(
  kind: Kind,
  mode: Mode,
  options: Options
) => adapterDescriptorSchema(kind, options).extend({ mode: z.literal(mode) });

/** One variant per public adapter factory. */
const adapterVariants = [
  descriptor("algolia", "hosted", algoliaOptionsSchema),
  descriptor("flexsearch", "static", flexsearchOptionsSchema),
  descriptor("mixedbread", "server", mixedbreadOptionsSchema),
  descriptor("orama", "static", oramaOptionsSchema),
  descriptor("orama-cloud", "hosted", oramaCloudOptionsSchema),
  descriptor("pagefind", "pagefind", pagefindOptionsSchema),
  descriptor("typesense", "hosted", typesenseOptionsSchema),
] as const;

/** What a public factory returns, as the config schema accepts it. */
export type SearchAdapterInput = z.input<(typeof adapterVariants)[number]>;

/**
 * Validates a descriptor — one a factory returned, or the `none` descriptor
 * the config schema substitutes for `false` — and resolves it to the
 * canonical form, so every consumer reads `mode`, `runtimeDeps`, and
 * `requiredSecrets` straight off the descriptor. `none` is internal: it is
 * not part of {@link SearchAdapterInput}, so `search: { kind: "none" }` is a
 * type error even though the runtime schema admits it.
 */
export const resolvedSearchAdapterSchema = z
  .discriminatedUnion("kind", [
    ...adapterVariants,
    descriptor("none", "none", z.looseObject({})),
  ])
  .transform((value): ResolvedSearchAdapter => {
    switch (value.kind) {
      case "algolia": {
        return algolia(value.options);
      }
      case "flexsearch": {
        return flexsearch(value.options);
      }
      case "mixedbread": {
        return mixedbread(value.options);
      }
      case "none": {
        return NONE_SEARCH_ADAPTER;
      }
      case "orama": {
        return orama(value.options);
      }
      case "orama-cloud": {
        return oramaCloud(value.options);
      }
      case "pagefind": {
        return pagefind(value.options);
      }
      default: {
        return typesense(value.options);
      }
    }
  });

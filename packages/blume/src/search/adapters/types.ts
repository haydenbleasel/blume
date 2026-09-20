import type { AdapterDescriptor, JsonValue } from "../../core/adapter.ts";

/**
 * How a search adapter integrates with the generated runtime.
 *
 * - `static` adapters ship a client-side index (`blume-search.json`) that the
 *   browser loads and queries — Orama, FlexSearch.
 * - `pagefind` builds its own index from the rendered HTML after the build.
 * - `hosted` adapters are queried directly from the browser against an
 *   external service, with a build-time sync uploading the index — Algolia,
 *   Orama Cloud, Typesense.
 * - `server` adapters proxy queries through a generated `/api/search` endpoint
 *   that holds a secret key, so they require server output — Mixedbread.
 * - `none` is the resolved form of `search: false`: search is disabled.
 */
export type SearchAdapterMode =
  | "static"
  | "pagefind"
  | "hosted"
  | "server"
  | "none";

/**
 * Options for an adapter that needs none. Any key given still rides along to
 * the generated client verbatim, like every adapter's options. JSON values
 * only: the descriptor is inlined into the generated project as a literal.
 */
export interface KeylessSearchOptions {
  [option: string]: JsonValue;
}

/**
 * The descriptor a search adapter factory returns and `blume.config.ts`
 * carries under `search`: the shared {@link AdapterDescriptor} contract plus
 * the adapter's integration `mode`. It is plain data, never a live client —
 * the runtime templates inline it as a literal into `.blume/` and ejected
 * files, so every field must survive a JSON round-trip.
 */
export interface SearchAdapter<
  Kind extends string = string,
  Mode extends SearchAdapterMode = SearchAdapterMode,
  Options = object,
> extends AdapterDescriptor<Kind, Options> {
  /** How the generated runtime queries this adapter. */
  mode: Mode;
}

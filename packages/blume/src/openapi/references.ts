import { normalizeRoute, withBasePath } from "../core/base-path.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import { trimChar } from "../core/trim.ts";
import type { ScalarOptions } from "../reference/scalar.ts";
import type { ResolvedReferenceAdapter } from "../reference/schema.ts";

// Re-exported from its home next to the other path helpers; `core/schema.ts`
// and downstream consumers historically imported it from here.
export { normalizeRoute } from "../core/base-path.ts";

/**
 * Pure resolution of the configured `reference` adapters into concrete routes
 * and labels — no file IO, so the content source, the
 * nav-target validation, the Scalar page generator, and the `blume:openapi`
 * data module all share one source of truth. Kept free of any Astro/template
 * imports so `core` can depend on it without a cycle.
 */

/**
 * Which adapter a reference came from. `openapi`, `asyncapi`, and `graphql`
 * are rendered by Blume into real pages; `scalar` is the embedded Scalar SPA
 * on a single route.
 */
export type ReferenceKind = ResolvedReferenceAdapter["kind"];

/** The kinds Blume renders into pages itself — everything but the Scalar embed. */
export type BlumeReferenceKind = Exclude<ReferenceKind, "scalar">;

/** Per-adapter display options for the Blume renderer. */
export interface ReferenceDisplay {
  /** Code-sample languages shown per operation; `false` for none. */
  codeSamples: string[] | false;
  /** Whether nested schema rows start expanded. */
  expandSchemas: boolean;
  /**
   * The "Try it" playground: whether operation pages render it, and the CORS
   * proxy the Send button routes through (`false` off, a URL string, or
   * `true` for the built-in `/_api-proxy` endpoint).
   */
  playground: { enabled: boolean; proxy: string | boolean };
}

/** A spec source resolved to a concrete route and label. */
export interface ReferenceSource {
  kind: ReferenceKind;
  /** Unique token derived from the route; the `<Operation source>` / data key. */
  slug: string;
  /** Normalized route the reference mounts at, e.g. `/reference`. */
  route: string;
  /**
   * Site-wide `basePath` the rendered pages are mounted under (`""` when
   * none). Kept separate from `route` — the content pipeline applies it to
   * staged entries itself — so consumers prefix only the URLs they emit.
   */
  basePath: string;
  label: string;
  /** Whether generated pages are included in llms.txt/llms-full.txt. */
  includeInLlms: boolean;
  /** Whether generated pages are included in site search. */
  includeInSearch: boolean;
  /** Whether generated pages emit noindex metadata and stay out of the sitemap. */
  noindex: boolean;
  /**
   * Whether operation meta descriptions end with the generated English
   * "Reference for …" sentence, or carry the spec's own prose alone.
   */
  seoDescriptionSuffix: boolean;
  /** Local path or `http(s)` URL, verbatim from config. */
  spec: string;
  /**
   * OpenAPI Overlay documents applied to `spec` in order (`openapi()` and
   * `scalar()` only).
   */
  overlays?: string[];
  /**
   * URL of the live GraphQL endpoint the playground and code samples target
   * (GraphQL only — a schema, unlike an OpenAPI document, names no server).
   */
  endpoint?: string;
  /**
   * The `scalar()` adapter's own options (`scalar` kind only): `theme` plus
   * any Scalar config forwarded verbatim to `<ScalarComponent>`, which takes
   * precedence over Blume's derived spec/theme config.
   */
  scalar?: ScalarOptions;
  /** Display options carried through to the Blume renderer. */
  display: ReferenceDisplay;
  /**
   * Warnings recorded while deduping — another source's route collided with
   * this one and was dropped. Surfaced as diagnostics when the source loads.
   */
  collisions?: string[];
}

/** A reference Blume renders itself: one the content pipeline stages pages for. */
export type BlumeReferenceSource = ReferenceSource & {
  kind: BlumeReferenceKind;
};

const isBlumeReference = (ref: ReferenceSource): ref is BlumeReferenceSource =>
  ref.kind !== "scalar";

// Keep Unicode letters/marks/numbers so diacritics stay in the slug (ASCII-only
// stripping turned `Größe` into `gr-e`, which the nav humanizer rendered as
// `Gr E`); `\p{M}` keeps combining marks attached to their base letter, which
// NFC cannot always compose away (Devanagari vowel signs, Turkish `İ`'s
// lowercased combining dot).
const NON_SLUG = /[^\p{L}\p{M}\p{N}]+/gu;
// Format characters (ZWNJ, ZWJ, bidi controls) separate no words — hyphenating
// them would split Persian/Indic compounds the way ASCII stripping split
// `Größe` — so they are dropped, not replaced.
const FORMAT_CHARS = /\p{Cf}/gu;
// A combining mark at the start of the slug has no base letter to attach to
// (it would glue onto the preceding `/` in a URL), and a marks-only slug must
// come out empty so callers' fallbacks (`operations`, `reference`) fire.
const LEADING_MARKS = /^\p{M}+/u;

/**
 * Lowercase, hyphen-separated slug: `Add a Pet!` -> `add-a-pet`. Unicode
 * letters are kept (`Größe` -> `größe`), NFC-normalized so canonically
 * equivalent spellings (NFD input from macOS tooling) land on one slug.
 * Non-ASCII slugs rely on the emitter percent-encoding the URL where a raw
 * URI is required (sitemap, canonical).
 */
export const slugify = (text: string): string =>
  trimChar(
    text
      .normalize("NFC")
      .toLowerCase()
      .replace(FORMAT_CHARS, "")
      .replace(NON_SLUG, "-"),
    "-"
  ).replace(LEADING_MARKS, "");

/** A stable per-reference token from its route: `/api/events` -> `api-events`. */
const routeSlug = (route: string): string =>
  slugify(trimChar(route, "/")) || "reference";

/** The label a source gets when it names none (numbered when there are several). */
const DEFAULT_LABELS: Record<ReferenceKind, string> = {
  asyncapi: "Events",
  graphql: "GraphQL",
  openapi: "API Reference",
  scalar: "API Reference",
};

/** The Blume renderer has nothing to show for a Scalar embed. */
const NO_DISPLAY: ReferenceDisplay = {
  codeSamples: [],
  expandSchemas: false,
  playground: { enabled: false, proxy: false },
};

const displayOf = (adapter: ResolvedReferenceAdapter): ReferenceDisplay => {
  if (adapter.kind === "scalar") {
    return NO_DISPLAY;
  }
  return {
    codeSamples: adapter.options.codeSamples,
    // GraphQL field tables have no nesting, so `graphql()` takes no
    // `expandSchemas` toggle.
    expandSchemas:
      adapter.kind === "graphql" ? false : adapter.options.expandSchemas,
    playground: adapter.options.playground,
  };
};

/**
 * A `scalar()` adapter's options minus the ones Blume resolves itself
 * (`route`, `sources`): `theme` and the verbatim Scalar passthrough, which
 * the generated page inlines.
 */
const scalarOptionsOf = (
  options: Extract<ResolvedReferenceAdapter, { kind: "scalar" }>["options"]
): ScalarOptions =>
  Object.fromEntries(
    Object.entries(options).filter(
      ([key]) => key !== "route" && key !== "sources"
    )
  );

/** A source row with every kind's fields reconciled onto one shape. */
interface SourceRow {
  endpoint?: string;
  includeInLlms: boolean;
  includeInSearch: boolean;
  label?: string;
  noindex: boolean;
  route?: string;
  seoDescriptionSuffix: boolean;
  spec: string;
  overlays?: string[];
}

/**
 * One row per source, with the kind-specific fields already reconciled: a
 * GraphQL source's `endpoint` falls back to the adapter-wide default (the
 * common single-schema case pairs it with the `spec` shorthand); the other
 * kinds have no endpoint at all. A Scalar source carries only `noindex` of
 * the per-source controls — the embed sits outside search and llms.txt, so
 * the other two read as off.
 */
const sourceRowsOf = (adapter: ResolvedReferenceAdapter): SourceRow[] => {
  if (adapter.kind === "graphql") {
    return adapter.options.sources.map((source) => ({
      ...source,
      endpoint: source.endpoint ?? adapter.options.endpoint,
    }));
  }
  if (adapter.kind === "scalar") {
    return adapter.options.sources.map((source) => ({
      ...source,
      includeInLlms: false,
      includeInSearch: false,
      seoDescriptionSuffix: false,
    }));
  }
  return adapter.options.sources;
};

const referencesFor = (
  adapter: ResolvedReferenceAdapter,
  basePath: string
): ReferenceSource[] => {
  const sources = sourceRowsOf(adapter);
  const base = normalizeRoute(adapter.options.route);
  const defaultLabel = DEFAULT_LABELS[adapter.kind];
  const display = displayOf(adapter);

  return sources.map((source, index) => {
    const label =
      source.label ??
      (sources.length > 1 ? `${defaultLabel} ${index + 1}` : defaultLabel);

    let route: string;
    if (source.route) {
      route = normalizeRoute(source.route);
    } else if (sources.length === 1) {
      route = base;
    } else {
      const suffix = source.label ? slugify(source.label) : "";
      route = normalizeRoute(`${base}/${suffix || index + 1}`);
    }

    const reference: ReferenceSource = {
      basePath,
      display,
      includeInLlms: source.includeInLlms,
      includeInSearch: source.includeInSearch,
      kind: adapter.kind,
      label,
      noindex: source.noindex,
      route,
      seoDescriptionSuffix: source.seoDescriptionSuffix,
      slug: routeSlug(route),
      spec: source.spec,
    };
    if (adapter.kind === "scalar") {
      reference.scalar = scalarOptionsOf(adapter.options);
    }
    if (source.endpoint !== undefined) {
      reference.endpoint = source.endpoint;
    }
    if (source.overlays !== undefined) {
      reference.overlays = source.overlays;
    }
    return reference;
  });
};

/**
 * Resolve every configured reference, in `reference` order: Blume's own pages
 * for `openapi()`, `asyncapi()`, and `graphql()`, and one embedded Scalar page
 * per `scalar()` source.
 */
export const resolveReferences = (config: ResolvedConfig): ReferenceSource[] =>
  config.reference.flatMap((adapter) =>
    referencesFor(adapter, config.basePath)
  );

/**
 * Mounted route for every reference, regardless of kind. References no
 * longer add a header tab automatically — authors point a `navigation.tabs`
 * entry at one of these routes to surface it (and, for Blume-rendered specs, to
 * scope its operations sidebar). These routes are whitelisted as valid nav
 * targets so such a tab doesn't read as a broken link.
 */
export const referenceRoutes = (config: ResolvedConfig): string[] =>
  resolveReferences(config).map((ref) =>
    // Blume-rendered operation pages flow through the content pipeline and are
    // mounted under `basePath`. Scalar references are a single embedded page
    // injected at the raw `route`, left root-anchored.
    ref.kind === "scalar" ? ref.route : withBasePath(config.basePath, ref.route)
  );

/**
 * Accept one resolved reference into the deduped Blume-rendered set, or return
 * null to skip it. Mutates `seen`/`usedSlugs` so repeated routes/slugs collapse.
 * A dropped route collision is recorded on the kept reference (mirroring the
 * Scalar path's warning) — losing a whole spec's pages must not be silent.
 */
const blumeReferenceOf = (
  ref: ReferenceSource,
  seen: Map<string, BlumeReferenceSource>,
  usedSlugs: Set<string>
): BlumeReferenceSource | null => {
  if (!isBlumeReference(ref)) {
    return null;
  }
  const kept = seen.get(ref.route);
  if (kept) {
    (kept.collisions ??= []).push(
      `Two API reference sources resolve to ${ref.route}; keeping the first.`
    );
    return null;
  }
  // Distinct routes can slugify identically (`/api/v1` and `/api-v1` both
  // yield `api-v1`). The slug keys the `blume:openapi` data module, so a
  // collision would let one spec silently overwrite the other while the
  // loser's pages still point at the shared key — disambiguate.
  let { slug } = ref;
  let n = 2;
  while (usedSlugs.has(slug)) {
    slug = `${ref.slug}-${n}`;
    n += 1;
  }
  usedSlugs.add(slug);
  const accepted = slug === ref.slug ? ref : { ...ref, slug };
  // Keep the accepted object (not the original) so a later collision's warning
  // lands on the reference the caller actually receives.
  seen.set(ref.route, accepted);
  return accepted;
};

/** Blume-rendered references (every kind but Scalar), deduped by route (first wins). */
export const blumeReferences = (
  config: ResolvedConfig
): BlumeReferenceSource[] => {
  const seen = new Map<string, BlumeReferenceSource>();
  const usedSlugs = new Set<string>();
  const result: BlumeReferenceSource[] = [];
  for (const ref of resolveReferences(config)) {
    const accepted = blumeReferenceOf(ref, seen, usedSlugs);
    if (accepted) {
      result.push(accepted);
    }
  }
  return result;
};

/** Whether any reference is Scalar-rendered (gates the Scalar pages). */
export const hasScalarReferences = (config: ResolvedConfig): boolean =>
  resolveReferences(config).some((ref) => ref.kind === "scalar");

/**
 * The Blume-rendered references whose enabled playground opted into the
 * built-in CORS proxy with `proxy: true`. A proxy URL string points at an
 * external service, and `false` sends requests directly — neither routes
 * through the endpoint. AsyncAPI never does: an event composer's WebSocket
 * connect is direct, so its `proxy` has nothing to forward. Drawn from the
 * deduped set so the slugs match the `blume:openapi` data keys; the
 * generator's per-spec allowlist diagnostics key on this, so it shares one
 * definition with {@link needsPlaygroundProxy}.
 */
export const builtinProxyReferences = (
  config: ResolvedConfig
): BlumeReferenceSource[] =>
  blumeReferences(config).filter(
    (ref) =>
      ref.kind !== "asyncapi" &&
      ref.display.playground.enabled &&
      ref.display.playground.proxy === true
  );

/**
 * Whether hand-written endpoint pages (`api` frontmatter) send their Try it
 * requests through the built-in proxy: `api.playground.proxy: true`.
 */
export const apiPagesUseBuiltinProxy = (config: ResolvedConfig): boolean =>
  config.api.playground.enabled && config.api.playground.proxy === true;

/**
 * Whether the built-in playground CORS proxy endpoint (`/_api-proxy`) must be
 * generated: some Blume-rendered reference's playground opted into it with
 * `proxy: true`, or the hand-written endpoint pages' did. Shared by the server
 * feature gate and the generator so the two can never disagree.
 */
export const needsPlaygroundProxy = (config: ResolvedConfig): boolean =>
  builtinProxyReferences(config).length > 0 || apiPagesUseBuiltinProxy(config);

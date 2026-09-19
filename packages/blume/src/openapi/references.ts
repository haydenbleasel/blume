import { normalizeRoute, withBasePath } from "../core/base-path.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import { trimChar } from "../core/trim.ts";
import type { ScalarOptions, ScalarRenderer } from "../reference/scalar.ts";
import type { ResolvedReferenceAdapter } from "../reference/schema.ts";

// Re-exported from its home next to the other path helpers; `core/schema.ts`
// and downstream consumers historically imported it from here.
export { normalizeRoute } from "../core/base-path.ts";

/**
 * Pure resolution of the configured `reference` adapters into concrete routes,
 * labels, and a renderer choice — no file IO, so the content source, the
 * nav-target validation, the Scalar page generator, and the `blume:openapi`
 * data module all share one source of truth. Kept free of any Astro/template
 * imports so `core` can depend on it without a cycle.
 */

export type ReferenceKind = ResolvedReferenceAdapter["kind"];

/** Who renders a reference: Blume's own UI, or the embedded Scalar SPA. */
export type ReferenceRenderer = "blume" | "scalar";

/** Per-adapter display options for the Blume renderer. */
export interface ReferenceDisplay {
  /** Code-sample languages shown per operation. */
  codeSamples: string[];
  /** Whether nested schema rows start expanded. */
  expandSchemas: boolean;
  /**
   * The "Try it" playground: whether operation pages render it, and the CORS
   * proxy the Send button routes through (`false` off, a URL string, or
   * `true` for the built-in `/_api-proxy` endpoint).
   */
  playground: { enabled: boolean; proxy: string | boolean };
}

/** A spec source resolved to a concrete route, label, and renderer. */
export interface ReferenceSource {
  kind: ReferenceKind;
  renderer: ReferenceRenderer;
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
   * URL of the live GraphQL endpoint the playground and code samples target
   * (GraphQL only — a schema, unlike an OpenAPI document, names no server).
   */
  endpoint?: string;
  /**
   * The `scalar()` renderer's options (Scalar renderer only): `theme` plus
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
};

/**
 * The Scalar renderer an adapter opted into, or null for Blume's own UI.
 * GraphQL is always Blume-rendered — the Scalar SPA reads OpenAPI documents
 * only — so `graphql()` accepts no renderer to read.
 */
const scalarRendererOf = (
  adapter: ResolvedReferenceAdapter
): ScalarRenderer | null =>
  adapter.kind === "graphql" ? null : (adapter.options.renderer ?? null);

const displayOf = (adapter: ResolvedReferenceAdapter): ReferenceDisplay => ({
  codeSamples: adapter.options.codeSamples,
  // GraphQL field tables have no nesting, so `graphql()` takes no
  // `expandSchemas` toggle.
  expandSchemas:
    adapter.kind === "graphql" ? false : adapter.options.expandSchemas,
  playground: adapter.options.playground,
});

/**
 * One row per source, with the kind-specific fields already reconciled: a
 * GraphQL source's `endpoint` falls back to the adapter-wide default (the
 * common single-schema case pairs it with the `spec` shorthand); the other
 * kinds have no endpoint at all.
 */
const sourceRowsOf = (
  adapter: ResolvedReferenceAdapter
): (ResolvedReferenceAdapter["options"]["sources"][number] & {
  endpoint?: string;
})[] =>
  adapter.kind === "graphql"
    ? adapter.options.sources.map((source) => ({
        ...source,
        endpoint: source.endpoint ?? adapter.options.endpoint,
      }))
    : adapter.options.sources;

const referencesFor = (
  adapter: ResolvedReferenceAdapter,
  basePath: string
): ReferenceSource[] => {
  const sources = sourceRowsOf(adapter);
  const base = normalizeRoute(adapter.options.route);
  const defaultLabel = DEFAULT_LABELS[adapter.kind];
  const renderer = scalarRendererOf(adapter);
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
      renderer: renderer ? "scalar" : "blume",
      route,
      seoDescriptionSuffix: source.seoDescriptionSuffix,
      slug: routeSlug(route),
      spec: source.spec,
    };
    if (renderer) {
      reference.scalar = renderer.options;
    }
    if (source.endpoint !== undefined) {
      reference.endpoint = source.endpoint;
    }
    return reference;
  });
};

/**
 * Resolve every configured reference, in `reference` order. Each adapter
 * honors its `renderer` — Blume's own UI by default, with the embedded Scalar
 * SPA as the opt-out on the kinds that support it.
 */
export const resolveReferences = (config: ResolvedConfig): ReferenceSource[] =>
  config.reference.flatMap((adapter) =>
    referencesFor(adapter, config.basePath)
  );

/**
 * Mounted route for every reference, regardless of renderer. References no
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
    ref.renderer === "blume"
      ? withBasePath(config.basePath, ref.route)
      : ref.route
  );

/**
 * Accept one resolved reference into the deduped Blume-rendered set, or return
 * null to skip it. Mutates `seen`/`usedSlugs` so repeated routes/slugs collapse.
 * A dropped route collision is recorded on the kept reference (mirroring the
 * Scalar path's warning) — losing a whole spec's pages must not be silent.
 */
const blumeReferenceOf = (
  ref: ReferenceSource,
  seen: Map<string, ReferenceSource>,
  usedSlugs: Set<string>
): ReferenceSource | null => {
  if (ref.renderer !== "blume") {
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

/** Blume-rendered references (every kind), deduped by route (first wins). */
export const blumeReferences = (config: ResolvedConfig): ReferenceSource[] => {
  const seen = new Map<string, ReferenceSource>();
  const usedSlugs = new Set<string>();
  const result: ReferenceSource[] = [];
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
  resolveReferences(config).some((ref) => ref.renderer === "scalar");

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
): ReferenceSource[] =>
  blumeReferences(config).filter(
    (ref) =>
      ref.kind !== "asyncapi" &&
      ref.display.playground.enabled &&
      ref.display.playground.proxy === true
  );

/**
 * Whether the built-in playground CORS proxy endpoint (`/_api-proxy`) must be
 * generated: some Blume-rendered reference's playground opted into it with
 * `proxy: true`. Shared by the server feature gate and the generator so the
 * two can never disagree.
 */
export const needsPlaygroundProxy = (config: ResolvedConfig): boolean =>
  builtinProxyReferences(config).length > 0;

import { withBasePath } from "../core/base-path.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import { trimChar, trimEnd } from "../core/trim.ts";

/**
 * Pure resolution of the configured API reference blocks into concrete routes,
 * labels, and a renderer choice — no file IO, so the content source, the
 * nav-target validation, the Scalar page generator, and the `blume:openapi`
 * data module all share one source of truth. Kept free of any Astro/template
 * imports so `core` can depend on it without a cycle.
 */

export type ReferenceKind = "openapi" | "asyncapi";

/** Who renders a reference: Blume's own UI, or the embedded Scalar SPA. */
export type ReferenceRenderer = "blume" | "scalar";

/** Per-block display options for the Blume renderer. */
export interface ReferenceDisplay {
  /** Code-sample languages shown per operation. */
  codeSamples: string[];
  /** Whether nested schema rows start expanded. */
  expandSchemas: boolean;
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
  /** Local path or `http(s)` URL, verbatim from config. */
  spec: string;
  /** Per-block Scalar theme name override, if any (Scalar renderer only). */
  theme?: string;
  /** Display options carried through to the Blume renderer. */
  display: ReferenceDisplay;
  /**
   * Warnings recorded while deduping — another source's route collided with
   * this one and was dropped. Surfaced as diagnostics when the source loads.
   */
  collisions?: string[];
}

const NON_SLUG = /[^a-z0-9]+/gu;

export const slugify = (text: string): string =>
  trimChar(text.toLowerCase().replace(NON_SLUG, "-"), "-");

/** Normalize a configured route to a single leading slash, no trailing slash. */
export const normalizeRoute = (route: string): string => {
  const trimmed = route.trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const noTrailing = trimEnd(withSlash, "/");
  return noTrailing === "" ? "/" : noTrailing;
};

/** A stable per-reference token from its route: `/api/events` -> `api-events`. */
const routeSlug = (route: string): string =>
  slugify(trimChar(route, "/")) || "reference";

type Block = ResolvedConfig["openapi"] | ResolvedConfig["asyncapi"];

/** A spec is a single source (`spec` shorthand prepended to any `sources`). */
const sourcesOf = (
  block: Block
): { label?: string; route?: string; spec: string }[] => {
  const sources = [...block.sources];
  if (block.spec) {
    sources.unshift({ spec: block.spec });
  }
  return sources;
};

const referencesFor = (
  kind: ReferenceKind,
  block: Block,
  defaultLabel: string,
  renderer: ReferenceRenderer,
  display: ReferenceDisplay,
  basePath: string
): ReferenceSource[] => {
  if (!block.enabled) {
    return [];
  }
  const sources = sourcesOf(block);
  const base = normalizeRoute(block.route);

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

    return {
      basePath,
      display,
      kind,
      label,
      renderer,
      route,
      slug: routeSlug(route),
      spec: source.spec,
      theme: block.theme,
    };
  });
};

const NO_DISPLAY: ReferenceDisplay = { codeSamples: [], expandSchemas: false };

/**
 * Resolve every enabled reference. OpenAPI honors its `renderer` (Blume's own UI
 * by default); AsyncAPI is always rendered by Scalar for now.
 */
export const resolveReferences = (
  config: ResolvedConfig
): ReferenceSource[] => [
  ...referencesFor(
    "openapi",
    config.openapi,
    "API Reference",
    config.openapi.renderer,
    {
      codeSamples: config.openapi.codeSamples,
      expandSchemas: config.openapi.expandSchemas,
    },
    config.basePath
  ),
  ...referencesFor(
    "asyncapi",
    config.asyncapi,
    "Events",
    "scalar",
    NO_DISPLAY,
    config.basePath
  ),
];

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
  if (ref.kind !== "openapi" || ref.renderer !== "blume") {
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

/** Blume-rendered OpenAPI references, deduped by route (first wins). */
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

/** Whether any reference is Scalar-rendered (gates the `@scalar/astro` dep + pages). */
export const hasScalarReferences = (config: ResolvedConfig): boolean =>
  resolveReferences(config).some((ref) => ref.renderer === "scalar");

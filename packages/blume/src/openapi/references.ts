import type { ResolvedConfig } from "../core/schema.ts";
import type { NavTab } from "../core/types.ts";

/**
 * Pure resolution of the configured API reference blocks into concrete routes,
 * labels, and a renderer choice — no file IO, so the content source, the nav
 * tabs, the Scalar page generator, and the `blume:openapi` data module all share
 * one source of truth. Kept free of any Astro/template imports so `core` can
 * depend on it without a cycle.
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
  label: string;
  /** Local path or `http(s)` URL, verbatim from config. */
  spec: string;
  /** Per-block Scalar theme name override, if any (Scalar renderer only). */
  theme?: string;
  /** Display options carried through to the Blume renderer. */
  display: ReferenceDisplay;
}

const NON_SLUG = /[^a-z0-9]+/gu;
const SLUG_EDGES = /^-+|-+$/gu;
const ROUTE_EDGES = /^\/+|\/+$/gu;
const TRAILING_SLASH = /\/+$/u;

export const slugify = (text: string): string =>
  text.toLowerCase().replace(NON_SLUG, "-").replace(SLUG_EDGES, "");

/** Normalize a configured route to a single leading slash, no trailing slash. */
export const normalizeRoute = (route: string): string => {
  const trimmed = route.trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const noTrailing = withSlash.replace(TRAILING_SLASH, "");
  return noTrailing === "" ? "/" : noTrailing;
};

/** A stable per-reference token from its route: `/api/events` -> `api-events`. */
const routeSlug = (route: string): string =>
  slugify(route.replace(ROUTE_EDGES, "")) || "reference";

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
  display: ReferenceDisplay
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
    }
  ),
  ...referencesFor("asyncapi", config.asyncapi, "Events", "scalar", NO_DISPLAY),
];

/** Nav tabs (header links) for every reference, regardless of renderer. */
export const referenceTabs = (config: ResolvedConfig): NavTab[] =>
  resolveReferences(config).map((ref) => ({
    label: ref.label,
    path: ref.route,
  }));

/** Blume-rendered OpenAPI references, deduped by route (first wins). */
export const blumeReferences = (config: ResolvedConfig): ReferenceSource[] => {
  const seen = new Set<string>();
  const result: ReferenceSource[] = [];
  for (const ref of resolveReferences(config)) {
    if (ref.kind !== "openapi" || ref.renderer !== "blume") {
      continue;
    }
    if (seen.has(ref.route)) {
      continue;
    }
    seen.add(ref.route);
    result.push(ref);
  }
  return result;
};

/** Whether any reference is Scalar-rendered (gates the `@scalar/astro` dep + pages). */
export const hasScalarReferences = (config: ResolvedConfig): boolean =>
  resolveReferences(config).some((ref) => ref.renderer === "scalar");

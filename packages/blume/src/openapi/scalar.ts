import { readFile } from "node:fs/promises";

import { isAbsolute, join } from "pathe";

import { scalarReferenceTemplate } from "../astro/templates.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import type { NavTab } from "../core/types.ts";
import { resolveAccent, resolveRadius } from "../theme/palette.ts";

/**
 * API reference support, delegated wholesale to Scalar (`@scalar/astro`). Blume
 * resolves the configured spec sources into routes, generates one self-contained
 * Scalar page per source, and adds a nav tab. OpenAPI and AsyncAPI share this
 * exact path — Scalar auto-detects the document type — so the only difference
 * between the two config blocks is their default route and nav label.
 */

type ReferenceKind = "openapi" | "asyncapi";

/** A spec source resolved to a concrete route and nav label. */
export interface ReferenceSource {
  kind: ReferenceKind;
  /** Normalized route the reference mounts at, e.g. `/reference`. */
  route: string;
  label: string;
  /** Local path or `http(s)` URL, verbatim from config. */
  spec: string;
  /** Per-block Scalar theme name override, if any. */
  theme?: string;
}

/** A generated reference page, ready to write under `src/pages`. */
export interface ReferenceFile {
  /** Path relative to `src/pages`, e.g. `reference.astro`, `api/events.astro`. */
  pagePath: string;
  content: string;
}

const URL_SPEC = /^https?:\/\//u;
const NON_SLUG = /[^a-z0-9]+/gu;
const SLUG_EDGES = /^-+|-+$/gu;
const ROUTE_EDGES = /^\/+|\/+$/gu;
const TRAILING_SLASH = /\/+$/u;

const slugify = (text: string): string =>
  text.toLowerCase().replace(NON_SLUG, "-").replace(SLUG_EDGES, "");

/** Normalize a configured route to a single leading slash, no trailing slash. */
const normalizeRoute = (route: string): string => {
  const trimmed = route.trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const noTrailing = withSlash.replace(TRAILING_SLASH, "");
  return noTrailing === "" ? "/" : noTrailing;
};

/** The `src/pages`-relative file path for a reference route. */
const referencePagePath = (route: string): string => {
  const segments = route.replace(ROUTE_EDGES, "");
  return `${segments === "" ? "index" : segments}.astro`;
};

/** A spec is a single source (`spec` shorthand prepended to any `sources`). */
type Block = ResolvedConfig["openapi"] | ResolvedConfig["asyncapi"];

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
  defaultLabel: string
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

    return { kind, label, route, spec: source.spec, theme: block.theme };
  });
};

/**
 * Resolve every enabled reference source into its route and label. Pure (no file
 * IO), so the nav and the page generator stay in sync from one source of truth.
 */
export const resolveReferences = (
  config: ResolvedConfig
): ReferenceSource[] => [
  ...referencesFor("openapi", config.openapi, "API Reference"),
  ...referencesFor("asyncapi", config.asyncapi, "Events"),
];

/** Nav tabs (header links) for the configured references. */
export const referenceTabs = (config: ResolvedConfig): NavTab[] =>
  resolveReferences(config).map((ref) => ({
    label: ref.label,
    path: ref.route,
  }));

/** Whether any reference block is enabled (gates dependency + page wiring). */
export const hasReferences = (config: ResolvedConfig): boolean =>
  config.openapi.enabled || config.asyncapi.enabled;

const darkModeConfig = (
  mode: ResolvedConfig["theme"]["mode"]
): Record<string, boolean> => {
  if (mode === "dark") {
    return { darkMode: true };
  }
  if (mode === "light") {
    return { darkMode: false };
  }
  // "system": leave Scalar to follow the OS preference.
  return {};
};

/**
 * Map Blume's theme onto Scalar's. An explicit `theme` name wins; otherwise we
 * keep Scalar's default theme and layer Blume's accent/radius on top via
 * `customCss`. Scalar re-injects `customCss` after its bundled theme, so these
 * variables reliably override the defaults. Best-effort, not pixel-exact.
 */
const themeConfiguration = (
  config: ResolvedConfig,
  override?: string
): Record<string, unknown> => {
  if (override) {
    return { theme: override };
  }
  const accent = resolveAccent(config.theme);
  const radius = resolveRadius(config.theme);
  return {
    customCss: `:root,.light-mode,.dark-mode{--scalar-color-accent:${accent};--scalar-radius:${radius};}`,
    ...darkModeConfig(config.theme.mode),
  };
};

/** Build the Scalar spec config for a source: inline `content` or remote `url`. */
const specConfiguration = async (
  spec: string,
  root: string
): Promise<{ config: Record<string, unknown>; warning?: string }> => {
  if (URL_SPEC.test(spec)) {
    return { config: { url: spec } };
  }
  // A local spec is read at generate time and inlined as `content`, so the page
  // stays self-contained and nothing is copied into the user's source tree.
  const absolute = isAbsolute(spec) ? spec : join(root, spec);
  try {
    return { config: { content: await readFile(absolute, "utf-8") } };
  } catch {
    return {
      config: { url: spec },
      warning: `API reference spec not found: "${spec}" (looked in ${absolute}).`,
    };
  }
};

/**
 * Build the Scalar reference page(s) for the project. Reads local specs, maps
 * the theme, and skips routes that collide with a content page or another
 * source. Returns the files to write under `src/pages` plus any warnings.
 */
export const buildReferenceFiles = async (options: {
  config: ResolvedConfig;
  root: string;
  contentRoutes: ReadonlySet<string>;
}): Promise<{ files: ReferenceFile[]; warnings: string[] }> => {
  const { config, root, contentRoutes } = options;
  const warnings: string[] = [];

  // Resolve and dedupe routes first (sync), then read every spec in parallel.
  const seen = new Set<string>();
  const accepted: ReferenceSource[] = [];
  for (const ref of resolveReferences(config)) {
    if (seen.has(ref.route)) {
      warnings.push(
        `Two API reference sources resolve to ${ref.route}; keeping the first.`
      );
      continue;
    }
    if (contentRoutes.has(ref.route)) {
      warnings.push(
        `API reference route ${ref.route} collides with a content page; skipping the reference there.`
      );
      continue;
    }
    seen.add(ref.route);
    accepted.push(ref);
  }

  const built = await Promise.all(
    accepted.map(async (ref) => ({
      ref,
      spec: await specConfiguration(ref.spec, root),
    }))
  );

  const files: ReferenceFile[] = [];
  for (const { ref, spec } of built) {
    if (spec.warning) {
      warnings.push(spec.warning);
    }
    const pagePath = referencePagePath(ref.route);
    // Relative path from the page back to src/generated/data.json: a page one
    // directory deep (api/events.astro) needs an extra "../".
    const depth = pagePath.split("/").length - 1;
    files.push({
      content: scalarReferenceTemplate({
        configuration: {
          ...spec.config,
          ...themeConfiguration(config, ref.theme),
        },
        dataImport: `${"../".repeat(depth + 1)}generated/data.json`,
        route: ref.route,
        title: ref.label,
      }),
      pagePath,
    });
  }

  return { files, warnings };
};

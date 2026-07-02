import { readFile } from "node:fs/promises";

import { isAbsolute, join } from "pathe";

import { scalarReferenceTemplate } from "../astro/templates.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import { resolveAccent, resolveRadius } from "../theme/palette.ts";
import { resolveReferences } from "./references.ts";
import type { ReferenceSource } from "./references.ts";

/**
 * The Scalar renderer: an escape hatch (`openapi.renderer: "scalar"`) and the
 * path AsyncAPI still uses. Each Scalar-rendered spec becomes one self-contained
 * `@scalar/astro` page loaded client-side from Scalar's CDN. Blume's own OpenAPI
 * renderer (the default) lives in `source.ts` / the `components/openapi` set and
 * does not pass through here.
 */

/** A generated Scalar reference page, ready to write under `src/pages`. */
export interface ReferenceFile {
  /** Path relative to `src/pages`, e.g. `reference.astro`, `api/events.astro`. */
  pagePath: string;
  content: string;
}

const URL_SPEC = /^https?:\/\//u;
const ROUTE_EDGES = /^\/+|\/+$/gu;

/** The `src/pages`-relative file path for a reference route. */
const referencePagePath = (route: string): string => {
  const segments = route.replace(ROUTE_EDGES, "");
  return `${segments === "" ? "index" : segments}.astro`;
};

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
 * Build the Scalar reference page(s) for the project. Only Scalar-rendered
 * references are emitted here (Blume-rendered OpenAPI is staged content). Reads
 * local specs, maps the theme, and skips routes that collide with a content page
 * or another source. Returns the files to write under `src/pages` plus warnings.
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
    if (ref.renderer !== "scalar") {
      continue;
    }
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

import { readFile } from "node:fs/promises";

import pMap from "p-map";
import { basename, join } from "pathe";
import { glob } from "tinyglobby";

/** Astro hydration directives Blume applies to a convention island. */
export type IslandClientMode = "idle" | "load" | "only" | "visible";

/** Client framework an island is authored in, inferred from its extension. */
export type IslandFramework = "react" | "svelte" | "vue";

/** A discovered `islands/` component, ready to wrap and expose to MDX. */
export interface IslandSpec {
  /** Hydration directive, from `export const client` or the default. */
  client: IslandClientMode;
  /** Absolute path to the island source file. */
  file: string;
  /** Astro client framework, used to enable the renderer and for `client:only`. */
  framework: IslandFramework;
  /** Component name used in MDX — the file's basename without extension. */
  name: string;
}

export interface IslandDiscovery {
  islands: IslandSpec[];
  warnings: string[];
}

/** Hydration mode used when an island doesn't declare one. */
const DEFAULT_CLIENT: IslandClientMode = "visible";

/** Ceiling on concurrent island-file reads; unbounded fan-out risks EMFILE. */
const READ_CONCURRENCY = 16;

const VALID_MODES = new Set<IslandClientMode>([
  "idle",
  "load",
  "only",
  "visible",
]);

/** Whether a declared client mode is one Astro's directives support. */
const isClientMode = (mode: string): mode is IslandClientMode =>
  // SAFETY: `Set.has` only compares identity at runtime; the assertion widens
  // the lookup key so the narrower-typed set accepts it, and the `has` result
  // is exactly the predicate being claimed.
  VALID_MODES.has(mode as IslandClientMode);

/** Island extensions mapped to the Astro renderer that handles them. */
const FRAMEWORK_BY_EXT = new Map<string, IslandFramework>([
  ["jsx", "react"],
  ["svelte", "svelte"],
  ["tsx", "react"],
  ["vue", "vue"],
]);

// Captures the extension so we can both strip it from the name and pick the
// framework. Kept in sync with the glob below.
const ISLAND_FILE = /\.(?<ext>jsx|svelte|tsx|vue)$/u;

// Matches `export const client = "load"` (with optional type annotation and
// either quote style). Read statically so we never execute island code in Node.
const CLIENT_EXPORT =
  /export\s+const\s+client\s*(?::[^=]+)?=\s*["'](?<mode>\w+)["']/u;

export const readClientMode = (
  source: string,
  file: string,
  warnings: string[]
): IslandClientMode => {
  const mode = source.match(CLIENT_EXPORT)?.groups?.mode;
  if (!mode) {
    return DEFAULT_CLIENT;
  }
  if (!isClientMode(mode)) {
    warnings.push(
      `Island "${file}" declares an unknown client mode "${mode}"; defaulting to "${DEFAULT_CLIENT}". Use "load", "idle", "visible", or "only".`
    );
    return DEFAULT_CLIENT;
  }
  return mode;
};

/**
 * Discover convention islands under `<root>/islands`. Every `.tsx`/`.jsx`/
 * `.vue`/`.svelte` file becomes a globally-available, hydrated MDX component
 * named after the file (which must be PascalCase to be usable as a JSX tag).
 * Hydration defaults to `client:visible`; a file opts out with `export const
 * client = "load" | "idle" | "only"`. Discovery is path-based (a glob), so no
 * user code is executed.
 */
export const discoverIslands = async (
  root: string
): Promise<IslandDiscovery> => {
  const dir = join(root, "islands");
  // Enumerate everything and let ISLAND_FILE do the filtering below, so
  // unknown extensions take the skip guard instead of relying on a glob
  // pattern staying in sync with the regex and framework map.
  const matches = await glob(["**/*"], {
    absolute: true,
    cwd: dir,
    onlyFiles: true,
  });
  const files = matches.toSorted();
  const sources = await pMap(files, (file) => readFile(file, "utf-8"), {
    concurrency: READ_CONCURRENCY,
  });

  const islands: IslandSpec[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, string>();

  // Extracted so the skip paths become early `return`s (one `continue` budget
  // per loop under the lint rule) instead of `continue` statements.
  const collectIsland = (file: string, source: string): void => {
    const base = basename(file);
    const ext = base.match(ISLAND_FILE)?.groups?.ext;
    const framework = ext ? FRAMEWORK_BY_EXT.get(ext) : undefined;
    if (!framework) {
      return;
    }
    const name = base.replace(ISLAND_FILE, "");
    // The name is used verbatim as both an MDX tag and an unquoted object key
    // in the generated island map, so it must be a plain PascalCase identifier
    // — a `-`, `.`, or space (e.g. `Time-Picker.tsx`) would otherwise emit a
    // syntax-error module and fail the whole build with no pointer to the file.
    if (!/^[A-Z][A-Za-z0-9_]*$/u.test(name)) {
      warnings.push(
        `Island "${file}" must have a PascalCase identifier filename to be used in MDX (letters, digits, and underscores only, e.g. Counter.tsx → <Counter />); skipping it.`
      );
      return;
    }
    const existing = seen.get(name);
    if (existing) {
      warnings.push(
        `Two islands both resolve to <${name}> ("${existing}" and "${file}"); ignoring the second. Give them distinct filenames.`
      );
      return;
    }
    seen.set(name, file);
    islands.push({
      client: readClientMode(source, file, warnings),
      file,
      framework,
      name,
    });
  };

  for (const [index, file] of files.entries()) {
    collectIsland(file, sources[index] ?? "");
  }

  return { islands, warnings };
};

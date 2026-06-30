import { readFile } from "node:fs/promises";

import { join, relative } from "pathe";
import { glob } from "tinyglobby";

import type { IslandClientMode } from "./islands.ts";
import { readClientMode } from "./islands.ts";

/** Framework an example is authored in, inferred from its extension. */
export type ExampleFramework = "astro" | "react" | "svelte" | "vue";

/** A discovered `examples/` file, ready to wrap (live) and show (source). */
export interface ExampleSpec {
  /** Hydration directive for a framework example; `undefined` for `.astro`. */
  client?: IslandClientMode;
  /** Absolute path to the example source file. */
  file: string;
  /** Framework, or `astro` for a server-rendered (static) example. */
  framework: ExampleFramework;
  /** Shiki language for the source pane — the file extension. */
  lang: string;
  /** MDX-facing key: the path under `examples/`, sans extension, `/`-joined. */
  path: string;
  /** Raw source text shown in the code tab. */
  source: string;
}

export interface ExampleDiscovery {
  examples: ExampleSpec[];
  warnings: string[];
}

/** Example extensions mapped to the framework that renders them. */
const FRAMEWORK_BY_EXT: Record<string, ExampleFramework> = {
  astro: "astro",
  jsx: "react",
  svelte: "svelte",
  tsx: "react",
  vue: "vue",
};

// Captures the extension so we can strip it from the path key and pick the
// framework. Kept in sync with the glob below.
const EXAMPLE_FILE = /\.(?<ext>astro|jsx|svelte|tsx|vue)$/u;

/**
 * Discover preview examples under `<root>/examples`. Every `.astro`/`.tsx`/
 * `.jsx`/`.vue`/`.svelte` file becomes addressable by `<Component path="...">`,
 * where the path is the file's location under `examples/` without its extension
 * (e.g. `forms/login.tsx` → `forms/login`). Discovery is path-based (a glob),
 * so no example code is executed. Framework examples carry a hydration mode
 * (default `client:visible`, overridable via `export const client`); `.astro`
 * examples render statically with no client directive.
 */
export const discoverExamples = async (
  root: string
): Promise<ExampleDiscovery> => {
  const dir = join(root, "examples");
  const matches = await glob(["**/*.{astro,jsx,svelte,tsx,vue}"], {
    absolute: true,
    cwd: dir,
    onlyFiles: true,
  });
  const files = matches.toSorted();
  const sources = await Promise.all(
    files.map((file) => readFile(file, "utf-8"))
  );

  const examples: ExampleSpec[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, string>();

  for (const [index, file] of files.entries()) {
    const ext = file.match(EXAMPLE_FILE)?.groups?.ext;
    const framework = ext ? FRAMEWORK_BY_EXT[ext] : undefined;
    if (!(ext && framework)) {
      continue;
    }
    // Strip the trailing `.<ext>` to form the `<Component path>` key.
    const path = relative(dir, file).slice(0, -(ext.length + 1));
    const existing = seen.get(path);
    if (existing) {
      warnings.push(
        `Two examples both resolve to "${path}" ("${existing}" and "${file}"); ignoring the second. Give them distinct paths.`
      );
      continue;
    }
    seen.set(path, file);
    const source = sources[index] ?? "";
    examples.push({
      client:
        framework === "astro"
          ? undefined
          : readClientMode(source, file, warnings),
      file,
      framework,
      lang: ext,
      path,
      source,
    });
  }

  return { examples, warnings };
};

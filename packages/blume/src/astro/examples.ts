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
// framework. Kept in sync with the glob below — non-matching files a user glob
// happens to sweep in (e.g. a registry's `.ts` sources) are dropped here.
const EXAMPLE_FILE = /\.(?<ext>astro|jsx|svelte|tsx|vue)$/u;

// Renderable example files when `examples` names a plain directory.
const DEFAULT_EXAMPLE_GLOB = "**/*.{astro,jsx,svelte,tsx,vue}";

// Glob magic that turns `examples` from a plain directory into a pattern. `()`,
// `@`, and `+` are excluded so literal path segments (npm scopes, parens) keep
// resolving as directories; the extglob leads `*?!` still trigger here.
const GLOB_MAGIC = /[!*?[\]{}]/u;

/**
 * Split a glob into its static directory prefix and the remaining pattern, so
 * discovered files can be keyed relative to that prefix (e.g.
 * `registry/x/**\/examples/*` → `{ base: "registry/x", rest: "**\/examples/*" }`).
 */
const splitGlobBase = (pattern: string): { base: string; rest: string } => {
  const segments = pattern.split("/");
  // Only called when the pattern contains glob magic (see the caller), and `/`
  // is never magic, so the magic char always lands in a segment — `findIndex`
  // is never -1 here.
  const firstMagic = segments.findIndex((segment) => GLOB_MAGIC.test(segment));
  return {
    base: segments.slice(0, firstMagic).join("/"),
    rest: segments.slice(firstMagic).join("/"),
  };
};

/**
 * Discover preview examples for the `examples` config (default `examples`).
 * Every `.astro`/`.tsx`/`.jsx`/`.vue`/`.svelte` file becomes addressable by
 * `<Component path="...">`, where the path is the file's location without its
 * extension (e.g. `forms/login.tsx` → `forms/login`).
 *
 * `pattern` is a directory by default, but may be a glob (anything with
 * `*`/`?`/`[]`/`{}`/`!`) — then only matching files are discovered and each
 * `<Component path>` key is relative to the glob's static prefix. This lets a
 * registry layout that colocates component sources with their examples be
 * targeted directly (e.g. `registry/<pkg>/**\/examples/*`) without the sources —
 * which have no default export and so can't be wrapped — being swept in.
 *
 * Discovery is path-based (a glob), so no example code is executed. Framework
 * examples carry a hydration mode (default `client:visible`, overridable via
 * `export const client`); `.astro` examples render statically with no client
 * directive.
 */
export const discoverExamples = async (
  root: string,
  pattern = "examples"
): Promise<ExampleDiscovery> => {
  const { base, rest } = GLOB_MAGIC.test(pattern)
    ? splitGlobBase(pattern)
    : { base: pattern, rest: DEFAULT_EXAMPLE_GLOB };
  const dir = join(root, base);
  const matches = await glob([rest], {
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

  // Extracted so the two skip paths become early `return`s (one `continue`
  // budget per loop under the lint rule) instead of `continue` statements.
  const collectExample = (file: string, source: string): void => {
    const ext = file.match(EXAMPLE_FILE)?.groups?.ext;
    const framework = ext ? FRAMEWORK_BY_EXT[ext] : undefined;
    if (!(ext && framework)) {
      return;
    }
    // Strip the trailing `.<ext>` to form the `<Component path>` key.
    const path = relative(dir, file).slice(0, -(ext.length + 1));
    const existing = seen.get(path);
    if (existing) {
      warnings.push(
        `Two examples both resolve to "${path}" ("${existing}" and "${file}"); ignoring the second. Give them distinct paths.`
      );
      return;
    }
    seen.set(path, file);
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
  };

  for (const [index, file] of files.entries()) {
    collectExample(file, sources[index] ?? "");
  }

  return { examples, warnings };
};

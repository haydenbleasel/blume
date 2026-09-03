import { existsSync } from "node:fs";

import { dirname, join, resolve } from "pathe";
import ts from "typescript";

/**
 * Read the project's TypeScript path aliases (`compilerOptions.paths`) and turn
 * them into Vite `resolve.alias` entries, so `@/`-style imports in custom pages,
 * islands, and components resolve in the generated Astro build exactly as they
 * do in the user's own tooling.
 *
 * The generated `.blume/` runtime is its own Astro project with its own tsconfig
 * and never inherits the project's, so without this every shadcn-style `@/…`
 * import would have to be rewritten to a relative path. Reading the aliases here
 * lets those components port over unchanged.
 *
 * Parsing is the TypeScript compiler's own job — JSONC, the full `extends`
 * chain (relative paths, package specifiers, TS 5.0 arrays), `${configDir}`
 * substitution, and where relative `paths` anchor all follow tsc exactly
 * because tsc does the work. Best-effort and non-fatal: anything unreadable
 * yields no aliases.
 */

/**
 * tsc records the directory of the config that declared `paths` on the
 * resolved options (that is what relative targets anchor to when there is no
 * `baseUrl`), but leaves the field out of its public typings.
 */
interface PathsBaseOptions {
  pathsBasePath?: string;
}

/**
 * Parse-only host: `include` globbing would walk the whole project for a file
 * list nobody reads, so directories always enumerate as empty.
 */
const PARSE_HOST: ts.ParseConfigHost = {
  fileExists: ts.sys.fileExists,
  readDirectory: () => [],
  readFile: ts.sys.readFile,
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
};

/** Whether a `paths` fallback entry is a usable target (raw JSONC may lie). */
const isPathTarget = (target: string | undefined): target is string =>
  typeof target === "string";

/** Convert one tsconfig `paths` mapping to a Vite alias, or null to skip. */
const toAlias = (
  key: string,
  value: string[],
  baseDir: string
): { find: string; replacement: string } | null => {
  // tsconfig allows a fallback array; Vite aliases are 1:1, so take the first.
  const [first] = value;
  if (!isPathTarget(first)) {
    return null;
  }
  const find = key.endsWith("/*") ? key.slice(0, -2) : key;
  const target = first.endsWith("/*") ? first.slice(0, -2) : first;
  // A bare `*`/`/*` catch-all would alias every import — never wire that.
  if (find === "" || find === "*") {
    return null;
  }
  return { find, replacement: resolve(baseDir, target) };
};

/**
 * Resolve the project's tsconfig/jsconfig path aliases to absolute Vite
 * `resolve.alias` entries (`find` → absolute replacement). Returns `{}` when no
 * config or no usable `paths` is found.
 */
export const resolveTsconfigAliases = (
  root: string
): Record<string, string> => {
  const entry = ["tsconfig.json", "jsconfig.json"]
    .map((name) => join(root, name))
    .find((file) => existsSync(file));
  if (!entry) {
    return {};
  }
  const { config, error } = ts.readConfigFile(entry, ts.sys.readFile);
  if (error) {
    // Unreadable or malformed JSONC: no aliases, as before.
    return {};
  }
  const configDir = dirname(entry);
  // Diagnostics (an unresolvable `extends`, no input files) are tsc's to
  // report; like tsc, keep whatever options still resolved.
  const { options } = ts.parseJsonConfigFileContent(
    config,
    PARSE_HOST,
    configDir,
    undefined,
    entry
  );
  const { paths } = options;
  if (!paths) {
    return {};
  }
  // SAFETY: the assertion only exposes `pathsBasePath`, which tsc populates on
  // the resolved options but omits from `CompilerOptions`.
  const { pathsBasePath } = options as PathsBaseOptions;
  // tsc already made `baseUrl` absolute and expanded `${configDir}`.
  const baseDir = options.baseUrl ?? pathsBasePath ?? configDir;
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(paths)) {
    const alias = toAlias(key, value, baseDir);
    if (alias) {
      entries.push([alias.find, alias.replacement]);
    }
  }
  return Object.fromEntries(entries);
};

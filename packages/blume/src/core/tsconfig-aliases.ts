import { existsSync } from "node:fs";

import { parseTsconfig } from "get-tsconfig";
import { dirname, join, resolve } from "pathe";

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
 * Parsing is get-tsconfig's job — JSONC, the full `extends` chain (relative
 * paths, directories, package specifiers, TS 5.0 arrays), and the rebasing of
 * inherited relative paths all follow tsc's own semantics. Best-effort and
 * non-fatal: anything unparseable yields no aliases.
 */

/** TS 5.5's config-relative template prefix, literal by design in tsconfig. */
// oxlint-disable-next-line no-template-curly-in-string -- tsconfig's own syntax
const CONFIG_DIR_TEMPLATE = "${configDir}";

/** Substitute a leading `${configDir}` template with the config's directory. */
const substituteConfigDir = (value: string, configDir: string): string =>
  value.startsWith(CONFIG_DIR_TEMPLATE)
    ? join(configDir, value.slice(CONFIG_DIR_TEMPLATE.length))
    : value;

/** Whether a `paths` fallback entry is a usable target (raw JSONC may lie). */
const isPathTarget = (target: string | undefined): target is string =>
  typeof target === "string";

/** Convert one tsconfig `paths` mapping to a Vite alias, or null to skip. */
const toAlias = (
  key: string,
  value: string | string[],
  baseDir: string,
  configDir: string
): { find: string; replacement: string } | null => {
  // tsconfig allows a fallback array; Vite aliases are 1:1, so take the first.
  const first = Array.isArray(value) ? value[0] : value;
  if (!isPathTarget(first)) {
    return null;
  }
  const find = key.endsWith("/*") ? key.slice(0, -2) : key;
  const target = first.endsWith("/*") ? first.slice(0, -2) : first;
  // A bare `*`/`/*` catch-all would alias every import — never wire that.
  if (find === "" || find === "*") {
    return null;
  }
  return {
    find,
    replacement: resolve(baseDir, substituteConfigDir(target, configDir)),
  };
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
  let options: ReturnType<typeof parseTsconfig>["compilerOptions"];
  try {
    options = parseTsconfig(entry).compilerOptions;
  } catch {
    // Unparseable config or unresolvable extends: no aliases, as before.
    return {};
  }
  const paths = options?.paths;
  if (!paths) {
    return {};
  }
  const configDir = dirname(entry);
  // get-tsconfig rebases inherited relative values onto the entry config, so
  // `baseUrl` (and bare `paths` entries) anchor here after substitution.
  const baseDir = resolve(
    configDir,
    substituteConfigDir(options?.baseUrl ?? ".", configDir)
  );
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(paths)) {
    const alias = toAlias(key, value, baseDir, configDir);
    if (alias) {
      entries.push([alias.find, alias.replacement]);
    }
  }
  return Object.fromEntries(entries);
};

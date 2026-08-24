import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";

import { dirname, join, relative } from "pathe";
import { z } from "zod";

import { packageRoot } from "../core/package-root.ts";

/**
 * Post-build audit of a Vercel serverless function bundle.
 *
 * The Vercel adapter traces the server entry with `@vercel/nft` and copies
 * every file it reaches into `.vercel/output/functions/_render.func`. A bare
 * import the trace cannot resolve — a package that isn't reachable by walking
 * `node_modules` up from the chunk that imports it — is dropped *silently*,
 * and the deployed function dies on its first request with
 * `ERR_MODULE_NOT_FOUND` (Vercel reports it as `FUNCTION_INVOCATION_FAILED`).
 * Under an isolated linker (pnpm, Bun's `isolated` mode) that is exactly the
 * shape of Blume's own runtime dependencies: the SSR build leaves them
 * external, and they live under `blume`'s store directory, not the project
 * root. Nothing before deploy surfaces it — the build is green, a warm-cache
 * preview is green — so the bundle is re-checked here with Node's own
 * resolution rule: a package is present when some `node_modules/<name>` on
 * the walk from the importing chunk up to the function root exists.
 */

/** A bare package import the function bundle cannot satisfy. */
export interface MissingPackage {
  /** Function-relative paths of the chunks that import the package. */
  importers: string[];
  name: string;
}

/** One function directory's audit result. */
export interface FunctionBundleAudit {
  /** Absolute path of the `*.func` directory. */
  dir: string;
  missing: MissingPackage[];
}

const BUILTINS = new Set(builtinModules);

/** Specifier prefixes that never name an installed package. */
const NON_PACKAGE_PREFIXES = ["node:", "astro:", "virtual:", "data:", "\0"];

/**
 * The package a bare specifier resolves through (`@scope/name` or `name`), or
 * null for relative/absolute paths, Node builtins, and virtual ids.
 */
export const packageName = (specifier: string): string | null => {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    NON_PACKAGE_PREFIXES.some((prefix) => specifier.startsWith(prefix)) ||
    BUILTINS.has(specifier)
  ) {
    return null;
  }
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
  }
  return segments[0] || null;
};

/**
 * Static specifiers: a side-effect `import "x"` or an `import`/`export … from
 * "x"` clause. Only `import` takes the bare-string form — `export "x"` is not
 * syntax, so a runtime message quoting `export 'ALL'` must not match. The
 * specifier quote must not be escaped either: a backslash-quoted `from \"zod\"`
 * is a code sample serialized into a string (the MCP snapshot carries page
 * Markdown), not module syntax.
 */
const STATIC_IMPORT =
  /(?:^|[;\s}])(?:import\s*(?<!\\)["'](?<bare>[^"'\n]+)["']|(?:import|export)\s*[\w$*{},\s]*?\s*from\s*(?<!\\)["'](?<from>[^"'\n]+)["'])/gu;

/** Dynamic `import("…")` specifiers, same escaped-quote rule. */
const DYNAMIC_IMPORT =
  /\bimport\(\s*(?<!\\)["'](?<dynamic>[^"'\n]+)["']\s*\)/gu;

/** Every bare package name a module's source imports. */
export const importedPackages = (source: string): string[] => {
  const names = new Set<string>();
  for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    for (const match of source.matchAll(pattern)) {
      const groups = match.groups ?? {};
      const name = packageName(
        groups.bare ?? groups.from ?? groups.dynamic ?? ""
      );
      if (name) {
        names.add(name);
      }
    }
  }
  return [...names];
};

/** Whether `node_modules/<name>` exists on the walk from `from` up to `root`. */
const resolvable = (name: string, from: string, root: string): boolean => {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, "node_modules", name, "package.json"))) {
      return true;
    }
    if (dir === root) {
      return false;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
};

const MODULE_FILE = /\.(?:m?js|cjs)$/u;

/** The one `.vc-config.json` field the audit reads; the rest passes through. */
const vcConfigSchema = z.looseObject({ handler: z.string().optional() });

/** Every JavaScript module under `dir`, skipping any `node_modules`. */
const listModules = async (dir: string): Promise<string[]> => {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        // oxlint-disable-next-line no-await-in-loop -- sequential walk keeps ordering deterministic
        files.push(...(await listModules(path)));
      }
    } else if (entry.isFile() && MODULE_FILE.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
};

/**
 * Audit one function directory: read its `.vc-config.json` handler, scan
 * every module beside the handler (the adapter's `dist/server` tree) for bare
 * imports, and report the packages no `node_modules` on the walk up to the
 * function root provides. A function without a handler has nothing to check.
 */
export const auditFunctionBundle = async (
  funcDir: string
): Promise<MissingPackage[]> => {
  const configPath = join(funcDir, ".vc-config.json");
  if (!existsSync(configPath)) {
    return [];
  }
  const config = vcConfigSchema.safeParse(
    JSON.parse(await readFile(configPath, "utf-8"))
  );
  if (!config.success || !config.data.handler) {
    return [];
  }
  const serverDir = dirname(join(funcDir, config.data.handler));
  if (!existsSync(serverDir)) {
    return [];
  }
  const missing = new Map<string, string[]>();
  for (const file of await listModules(serverDir)) {
    // oxlint-disable-next-line no-await-in-loop -- sequential read keeps the importer lists ordered
    const source = await readFile(file, "utf-8");
    for (const name of importedPackages(source)) {
      if (resolvable(name, dirname(file), funcDir)) {
        continue;
      }
      const importers = missing.get(name) ?? [];
      importers.push(relative(funcDir, file));
      missing.set(name, importers);
    }
  }
  return [...missing]
    .map(([name, importers]) => ({ importers, name }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
};

/**
 * Audit every function in a Vercel Build Output tree (`.vercel/output`).
 * Functions with nothing missing are omitted; an output tree without a
 * `functions/` directory (a static build) yields nothing.
 */
export const auditVercelFunctions = async (
  outputDir: string
): Promise<FunctionBundleAudit[]> => {
  const functionsDir = join(outputDir, "functions");
  if (!existsSync(functionsDir)) {
    return [];
  }
  const audits: FunctionBundleAudit[] = [];
  const entries = await readdir(functionsDir, { withFileTypes: true });
  for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!(entry.isDirectory() && entry.name.endsWith(".func"))) {
      continue;
    }
    const dir = join(functionsDir, entry.name);
    // oxlint-disable-next-line no-await-in-loop -- sequential audit keeps the report ordered
    const missing = await auditFunctionBundle(dir);
    if (missing.length > 0) {
      audits.push({ dir, missing });
    }
  }
  return audits;
};

/** Blume's own runtime dependency names, from its published `package.json`. */
export const blumeDependencyNames = (): Set<string> => {
  const manifest: { dependencies?: Record<string, string> } = JSON.parse(
    readFileSync(join(packageRoot(), "package.json"), "utf-8")
  );
  return new Set(Object.keys(manifest.dependencies ?? {}));
};

/** What a build should do about an audit: nothing, warn, or fail. */
export interface FunctionBundleVerdict {
  /**
   * A missing package is one of Blume's own dependencies — the runtime Blume
   * generated imports it, so the function is certain to crash. Anything else
   * (a project's own external import) is reported but left to the author.
   */
  fatal: boolean;
  message: string;
}

/**
 * Describe a function's missing packages and how to fix them. Vercel's trace
 * only reaches packages resolvable from the project root, so the remedy is a
 * root-level dependency entry for each — the same mirror rule Blume's native
 * dependencies (`sharp`, `takumi-js`) already follow.
 */
export const functionBundleVerdict = (
  audit: FunctionBundleAudit,
  root: string,
  ownDependencies: ReadonlySet<string>
): FunctionBundleVerdict => {
  const names = audit.missing.map((entry) => entry.name);
  const lines = audit.missing.map(
    (entry) => `  - ${entry.name} (imported by ${entry.importers.join(", ")})`
  );
  const fatal = names.some((name) => ownDependencies.has(name));
  const message = [
    `The Vercel function bundle at ${relative(root, audit.dir) || audit.dir} is missing packages its server code imports, so the deployed function would fail on every request with ERR_MODULE_NOT_FOUND:`,
    ...lines,
    "Vercel's dependency trace only includes packages resolvable from the project root; under an isolated linker (pnpm, Bun's isolated mode) Blume's own dependencies are not. Add them to the project's package.json so the trace can find them:",
    `  npm install -D ${names.join(" ")}`,
  ].join("\n");
  return { fatal, message };
};

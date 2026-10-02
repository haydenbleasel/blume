import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { join } from "pathe";

import {
  commandsFor,
  detectProjectPackageManager,
} from "../cli/init/scaffold.ts";
import { packageRoot } from "../core/package-root.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import type { Diagnostic } from "../core/types.ts";

/** Whether a module specifier resolves from a directory via node resolution. */
export const canResolveFrom = (fromDir: string, spec: string): boolean => {
  try {
    createRequire(pathToFileURL(join(fromDir, "_.js")).href).resolve(spec);
    return true;
  } catch {
    return false;
  }
};

/** A package a configured feature imports that the project can't resolve. */
export interface MissingDependency {
  /** The package whose absence was detected. */
  dep: string;
  /** Every package to install for the feature (a framework and its integration). */
  install: string[];
  /** What needs it, as the message names it: `Search adapter "algolia"`. */
  owner: string;
}

/**
 * The declared `deps` of one feature that resolve neither from the project
 * root nor from the Blume package itself. A dep is available when the project
 * installed it OR Blume ships it (the same set the `.blume` deps link exposes
 * to the build). Resolving from the project root alone falsely flagged a
 * shipped SDK like Orama (the default provider) as missing whenever it wasn't
 * hoisted into the project, e.g. under isolated linkers. Each package is
 * resolved from its real location rather than through the `.blume` junction,
 * which can't be traversed reliably for store-symlinked deps.
 */
const unresolved = (
  owner: string,
  deps: readonly string[],
  root: string,
  pkgDir: string
): MissingDependency[] =>
  deps
    .filter(
      (dep) => !(canResolveFrom(root, dep) || canResolveFrom(pkgDir, dep))
    )
    .map((dep) => ({ dep, install: [dep], owner }));

/**
 * The search adapter's SDK, when missing. Provider SDKs are optional peers,
 * so a hosted adapter's client import fails in Vite without one.
 */
export const searchProviderDependencies = (
  provider: ResolvedConfig["search"]["provider"],
  root: string,
  pkgDir: string = packageRoot()
): MissingDependency[] =>
  unresolved(
    `Search adapter "${provider.kind}"`,
    provider.runtimeDeps,
    root,
    pkgDir
  );

/** Content source SDKs (`@notionhq/client`, `@sanity/client`), when missing. */
export const sourceAdapterDependencies = (
  sources: ResolvedConfig["content"]["sources"],
  root: string,
  pkgDir: string = packageRoot()
): MissingDependency[] =>
  sources.flatMap((source) =>
    unresolved(
      `Content source "${source.kind}"`,
      source.runtimeDeps,
      root,
      pkgDir
    )
  );

/**
 * The assistant adapter's provider SDK, when missing — only `gateway` needs
 * nothing beyond the core `ai` package Blume ships. An external `endpoint`
 * means no generated route, so no SDK is imported.
 */
export const assistantProviderDependencies = (
  ask: ResolvedConfig["ai"]["assistant"],
  root: string,
  pkgDir: string = packageRoot()
): MissingDependency[] =>
  ask?.enabled && !ask.endpoint
    ? unresolved(
        `Assistant provider "${ask.provider.kind}"`,
        ask.provider.runtimeDeps,
        root,
        pkgDir
      )
    : [];

/**
 * The narration provider's SDK, when missing: `openai()` speaks through
 * `@ai-sdk/openai`, which the build loads to generate the clips, while
 * `gateway()` needs nothing beyond the core `ai` package Blume ships.
 */
export const narrationProviderDependencies = (
  narration: ResolvedConfig["narration"],
  root: string,
  pkgDir: string = packageRoot()
): MissingDependency[] =>
  narration.enabled && narration.provider
    ? unresolved(
        `Narration provider "${narration.provider.kind}"`,
        narration.provider.runtimeDeps,
        root,
        pkgDir
      )
    : [];

/**
 * The deployment adapter's package, when missing. Node and Vercel ship with
 * Blume, so theirs always resolve; Netlify and Cloudflare are optional peers.
 * The generated astro.config.mjs imports the package directly, so without it
 * the build dies with an opaque ERR_MODULE_NOT_FOUND from the hidden config.
 */
export const deploymentAdapterDependencies = (
  deployment: ResolvedConfig["deployment"],
  root: string,
  pkgDir: string = packageRoot()
): MissingDependency[] =>
  unresolved(
    `Deployment adapter "${deployment.kind}"`,
    deployment.runtimeDeps,
    root,
    pkgDir
  );

/** Astro integration package each non-React island framework needs installed. */
const ISLAND_FRAMEWORK_DEPS = new Map([
  ["svelte", "@astrojs/svelte"],
  ["vue", "@astrojs/vue"],
]);

/**
 * A Vue/Svelte island's Astro integration, when missing — the generated config
 * imports it. React ships with Blume, so it never needs this. The framework
 * itself is installed alongside its integration.
 */
export const islandFrameworkDependencies = (
  frameworks: Iterable<string>,
  root: string
): MissingDependency[] =>
  [...frameworks].flatMap((framework) => {
    const dep = ISLAND_FRAMEWORK_DEPS.get(framework);
    return dep && !canResolveFrom(root, dep)
      ? [
          {
            dep,
            install: [dep, framework],
            owner: `Island framework "${framework}"`,
          },
        ]
      : [];
  });

/**
 * Every package the resolved config's adapters (and the given island
 * frameworks) import that isn't installed: the search SDK, content source
 * SDKs, the assistant and narration provider SDKs, the deployment adapter,
 * and island integrations. The adapters' `runtimeDeps` are the one place that
 * knows.
 */
export const missingRuntimeDependencies = (
  config: ResolvedConfig,
  root: string,
  frameworks: Iterable<string> = [],
  pkgDir: string = packageRoot()
): MissingDependency[] => [
  ...searchProviderDependencies(config.search.provider, root, pkgDir),
  ...sourceAdapterDependencies(config.content.sources, root, pkgDir),
  ...assistantProviderDependencies(config.ai.assistant, root, pkgDir),
  ...narrationProviderDependencies(config.narration, root, pkgDir),
  ...deploymentAdapterDependencies(config.deployment, root, pkgDir),
  ...islandFrameworkDependencies(frameworks, root),
];

/**
 * One diagnostic for every package the config imports that isn't installed,
 * with the command that installs them all through the project's package
 * manager (`npm install`, `pnpm add`, …), or undefined when nothing is
 * missing. `blume build` raises it as an error and `blume dev` as a warning;
 * `blume doctor` reports it before a build ever runs.
 */
export const missingDependencyDiagnostic = async (
  config: ResolvedConfig,
  root: string,
  severity: Diagnostic["severity"],
  frameworks: Iterable<string> = [],
  pkgDir: string = packageRoot()
): Promise<Diagnostic | undefined> => {
  const missing = missingRuntimeDependencies(config, root, frameworks, pkgDir);
  if (missing.length === 0) {
    return undefined;
  }
  const { add } = commandsFor(await detectProjectPackageManager(root));
  const needs = missing.map(({ dep, owner }) => `${owner} needs "${dep}"`);
  const packages = [...new Set(missing.flatMap(({ install }) => install))];
  return {
    code: "BLUME_DEPENDENCY_MISSING",
    message:
      missing.length === 1
        ? `${needs[0]}, which isn't installed.`
        : `These packages aren't installed: ${needs.join("; ")}.`,
    severity,
    suggestion: `Install ${packages.length === 1 ? "it" : "them"}: \`${add} ${packages.join(" ")}\`.`,
  };
};

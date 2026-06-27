import { existsSync } from "node:fs";

import { isAbsolute, join, resolve } from "pathe";

import type { ResolvedConfig } from "./schema.ts";
import type { ProjectContext } from "./types.ts";

const CONFIG_FILENAMES = [
  "blume.config.ts",
  "blume.config.mjs",
  "blume.config.js",
];
const MINTLIFY_CONFIG_FILENAMES = ["docs.json"];

const THEME_FILENAMES = ["theme.css", "custom.css", "style.css"];
const COMPONENTS_FILENAMES = ["components.tsx", "components.ts"];

const firstExisting = (root: string, names: string[]): string | null => {
  for (const name of names) {
    const candidate = join(root, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const allExisting = (root: string, names: string[]): string[] =>
  names
    .map((name) => join(root, name))
    .filter((candidate) => existsSync(candidate));

/** Locate a native Blume config file for a project root, if any. */
export const findBlumeConfigFile = (root: string): string | null =>
  firstExisting(root, CONFIG_FILENAMES);

/** Locate a Mintlify config file for a project root, if any. */
export const findMintlifyConfigFile = (root: string): string | null =>
  firstExisting(root, MINTLIFY_CONFIG_FILENAMES);

/** Locate any config file Blume can load for a project root, if any. */
export const findConfigFile = (root: string): string | null =>
  findBlumeConfigFile(root) ?? findMintlifyConfigFile(root);

/**
 * Resolve every path Blume needs from a project root and its resolved config.
 * Paths are absolute and normalized.
 */
export const resolveProjectContext = (
  root: string,
  config: ResolvedConfig
): ProjectContext => {
  const absoluteRoot = resolve(root);
  const configFile = findConfigFile(absoluteRoot);
  const isMintlifyProject = configFile?.endsWith("docs.json") === true;
  const outDir = join(absoluteRoot, ".blume");
  const contentRoot = isAbsolute(config.content.root)
    ? config.content.root
    : join(absoluteRoot, config.content.root);

  const pagesPath = join(absoluteRoot, config.content.pages);
  const pagesRoot = existsSync(pagesPath) ? pagesPath : null;
  const themeFiles = allExisting(absoluteRoot, THEME_FILENAMES);

  return {
    componentsFile: firstExisting(absoluteRoot, COMPONENTS_FILENAMES),
    configFile,
    contentRoot,
    outDir,
    pagesRoot,
    publicRoot: isMintlifyProject
      ? join(outDir, "public")
      : join(absoluteRoot, "public"),
    root: absoluteRoot,
    themeFile: themeFiles[0] ?? null,
    themeFiles,
  };
};

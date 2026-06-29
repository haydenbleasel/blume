import { existsSync } from "node:fs";

import { isAbsolute, join, resolve } from "pathe";

import type { ResolvedConfig } from "./schema.ts";
import type { ProjectContext } from "./types.ts";

const CONFIG_FILENAMES = [
  "blume.config.ts",
  "blume.config.mjs",
  "blume.config.js",
];

const THEME_FILENAMES = ["theme.css"];
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

/** Locate the Blume config file for a project root, if any. */
export const findConfigFile = (root: string): string | null =>
  firstExisting(root, CONFIG_FILENAMES);

/**
 * Resolve every path Blume needs from a project root and its resolved config.
 * Paths are absolute and normalized.
 */
export const resolveProjectContext = (
  root: string,
  config: ResolvedConfig
): ProjectContext => {
  const absoluteRoot = resolve(root);
  const contentRoot = isAbsolute(config.content.root)
    ? config.content.root
    : join(absoluteRoot, config.content.root);

  const pagesPath = join(absoluteRoot, config.content.pages);
  const pagesRoot = existsSync(pagesPath) ? pagesPath : null;

  return {
    componentsFile: firstExisting(absoluteRoot, COMPONENTS_FILENAMES),
    configFile: findConfigFile(absoluteRoot),
    contentRoot,
    outDir: join(absoluteRoot, ".blume"),
    pagesRoot,
    root: absoluteRoot,
    themeFile: firstExisting(absoluteRoot, THEME_FILENAMES),
  };
};

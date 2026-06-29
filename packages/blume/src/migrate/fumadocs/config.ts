import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { join } from "pathe";

import type { BlumeConfig } from "../../core/schema.ts";

/**
 * Build a `BlumeConfig` for a Fumadocs project. Fumadocs is code-first — its
 * navigation comes from the folder tree plus `meta.json` files, not a JSON
 * config — so there is little to translate. We take the title from
 * `package.json` and scrape the `loader({ baseUrl })` route prefix from the
 * source loader so migrated routes keep serving under `/<baseUrl>`. The source
 * files are TypeScript, so we read by pattern rather than executing them.
 */

/** Loader files that may hold `loader({ baseUrl: "/docs" })`. */
const SOURCE_FILES = [
  "lib/source.ts",
  "app/source.ts",
  "src/lib/source.ts",
  "src/app/source.ts",
  "source.ts",
];

const BASE_URL = /baseUrl\s*:\s*['"`](?<base>[^'"`]+)['"`]/u;

/** Title-case a package name (drop any scope) into a readable doc title. */
const prettifyTitle = (name: string): string => {
  const base = name.includes("/")
    ? name.slice(name.lastIndexOf("/") + 1)
    : name;
  const words = base.split(/[-_\s]+/u).filter(Boolean);
  if (words.length === 0) {
    return "Documentation";
  }
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

const readTitle = async (root: string): Promise<string> => {
  const packageJson = join(root, "package.json");
  if (!existsSync(packageJson)) {
    return "Documentation";
  }
  try {
    const parsed = JSON.parse(await readFile(packageJson, "utf-8")) as {
      name?: unknown;
    };
    return typeof parsed.name === "string" && parsed.name.trim()
      ? prettifyTitle(parsed.name)
      : "Documentation";
  } catch {
    return "Documentation";
  }
};

const scrapeBaseUrl = async (root: string): Promise<string | null> => {
  for (const candidate of SOURCE_FILES) {
    const file = join(root, candidate);
    if (!existsSync(file)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential probing of candidates
    const base = BASE_URL.exec(await readFile(file, "utf-8"))?.groups?.base;
    if (base) {
      return base;
    }
  }
  return null;
};

export interface FumadocsConfigResult {
  config: BlumeConfig;
  warnings: string[];
}

/** Resolve the Blume config and route prefix for a Fumadocs project. */
export const loadFumadocsConfig = async (
  root: string
): Promise<FumadocsConfigResult> => {
  const title = await readTitle(root);
  const baseUrl = await scrapeBaseUrl(root);
  // Default to the conventional Fumadocs `/docs` base when none is declared.
  const prefix = (baseUrl ?? "docs").replaceAll(/^\/+|\/+$/gu, "");
  const warnings: string[] = [];

  if (prefix) {
    warnings.push(
      `Docs are served under /${prefix} (set content.sources prefix); change it to "" to serve from the site root.`
    );
    return {
      config: {
        content: {
          sources: [{ prefix, root: "docs", type: "filesystem" }],
        },
        title,
      },
      warnings,
    };
  }

  warnings.push("Docs are served from the site root.");
  return { config: { title }, warnings };
};

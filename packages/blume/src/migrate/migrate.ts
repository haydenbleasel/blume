import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";

import { dirname, join, relative } from "pathe";
import { glob } from "tinyglobby";

import { migrateFumadocsProject } from "./fumadocs/index.ts";
import { migrateMintlifyProject } from "./mintlify/index.ts";
import { migrateNextraProject } from "./nextra/index.ts";
import { writeBlumeConfig } from "./shared.ts";

export interface MigrationResult {
  moved: number;
  warnings: string[];
}

/** Move files into `docs/`, returning how many moved and any skips. */
const moveIntoDocs = async (
  root: string,
  absoluteFiles: string[],
  options: { from?: string } = {}
): Promise<MigrationResult> => {
  const base = options.from ? join(root, options.from) : root;
  const warnings: string[] = [];
  let moved = 0;

  for (const file of absoluteFiles) {
    const rel = relative(base, file);
    const dest = join(root, "docs", rel);
    if (existsSync(dest)) {
      warnings.push(`Skipped ${rel} (target already exists)`);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential fs moves
    await mkdir(dirname(dest), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- sequential fs moves
    await rename(file, dest);
    moved += 1;
  }

  return { moved, warnings };
};

/**
 * Migrate a Mintlify project (`docs.json`/`mint.json` + MDX). Translates the
 * config, rewrites pages to idiomatic Blume MDX in place, and relocates assets.
 * Unlike the other migrators, content stays at the project root.
 */
export const migrateMintlify = (root: string): Promise<MigrationResult> =>
  migrateMintlifyProject(root);

/**
 * Migrate a Nextra project (`content/` or `pages/` + `_meta` files). Moves pages
 * into `docs/`, rewrites `<Callout>`s to directives, and converts every `_meta`
 * into a typed `meta.ts`, preserving navigation order and titles.
 */
export const migrateNextra = (root: string): Promise<MigrationResult> =>
  migrateNextraProject(root);

/**
 * Migrate a Fumadocs project (`content/docs` + `meta.json`). Moves pages into
 * `docs/`, rewrites Fumadocs MDX (callouts, `<Cards>`/`<Accordions>`/`<Files>`,
 * `<Tabs items>`, `<include>`) to idiomatic Blume markup, converts every
 * `meta.json` into a typed `meta.ts`, and preserves the `/docs` route prefix.
 */
export const migrateFumadocs = (root: string): Promise<MigrationResult> =>
  migrateFumadocsProject(root);

const migrateFromContentDir = async (
  root: string,
  sourceDir: string,
  options: { title: string }
): Promise<MigrationResult> => {
  if (!existsSync(join(root, sourceDir))) {
    return {
      moved: 0,
      warnings: [`Content directory ${sourceDir} not found.`],
    };
  }

  const files = await glob(["**/*.{md,mdx,mdoc}"], {
    absolute: true,
    cwd: join(root, sourceDir),
  });
  const result = await moveIntoDocs(root, files, { from: sourceDir });

  await writeBlumeConfig(root, { title: options.title });
  return result;
};

/** Migrate a Starlight project (src/content/docs). */
export const migrateStarlight = (root: string): Promise<MigrationResult> =>
  migrateFromContentDir(root, "src/content/docs", { title: "Documentation" });

export const migrators: Record<
  string,
  (root: string) => Promise<MigrationResult>
> = {
  fumadocs: migrateFumadocs,
  mintlify: migrateMintlify,
  nextra: migrateNextra,
  starlight: migrateStarlight,
};

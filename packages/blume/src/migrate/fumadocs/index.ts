import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import matter from "gray-matter";
import { dirname, join, relative } from "pathe";
import { glob } from "tinyglobby";

import { writeBlumeConfig } from "../shared.ts";
import { loadFumadocsConfig } from "./config.ts";
import {
  inlineFumadocsIncludes,
  rewriteFumadocsCallouts,
  rewriteFumadocsContainers,
  rewriteFumadocsTabs,
  stripFumadocsImports,
  unsupportedFumadocsComponents,
} from "./content.ts";
import { normalizeFumadocsPageMeta } from "./frontmatter.ts";
import { translateFumadocsMeta } from "./meta.ts";

export interface FumadocsMigrationResult {
  moved: number;
  warnings: string[];
}

/** Fumadocs keeps documentation under `content/docs/`. */
const SOURCE_DIR = "content/docs";
const PAGE_GLOB = "**/*.{md,mdx}";
const META_GLOB = "**/meta.json";
const IGNORE = ["**/node_modules/**"];

interface PageResult {
  includeWarnings: string[];
  moved: number;
  removed: string[];
  skipped: string | null;
  unsupported: string[];
}

/** Rewrite a single page to idiomatic Blume MDX and move it into `docs/`. */
const movePage = async (
  abs: string,
  base: string,
  root: string
): Promise<PageResult> => {
  const rel = relative(base, abs);
  const dest = join(root, "docs", rel);
  if (existsSync(dest)) {
    return {
      includeWarnings: [],
      moved: 0,
      removed: [],
      skipped: rel,
      unsupported: [],
    };
  }

  const raw = await readFile(abs, "utf-8");
  const included = await inlineFumadocsIncludes(raw, { filePath: abs });
  let text = stripFumadocsImports(included.content);
  text = rewriteFumadocsCallouts(text);
  text = rewriteFumadocsContainers(text);
  text = rewriteFumadocsTabs(text);
  const unsupported = unsupportedFumadocsComponents(text);

  const parsed = matter(text);
  const { data, removed } = normalizeFumadocsPageMeta(parsed.data);
  const content =
    Object.keys(data).length > 0
      ? matter.stringify(parsed.content, data)
      : parsed.content;

  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, content, "utf-8");
  await rm(abs, { force: true });
  return {
    includeWarnings: included.warnings,
    moved: 1,
    removed,
    skipped: null,
    unsupported,
  };
};

/** Convert one `meta.json` into a typed `meta.ts`, or relocate it if unparseable. */
const convertMeta = async (
  abs: string,
  base: string,
  root: string
): Promise<string[]> => {
  const rel = relative(base, abs);
  const raw = await readFile(abs, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const dest = join(root, "docs", rel);
    if (existsSync(dest)) {
      return [`Skipped ${rel} (target already exists)`];
    }
    await mkdir(dirname(dest), { recursive: true });
    await rename(abs, dest);
    return [
      `Could not parse ${rel}; moved as-is — convert it to meta.ts by hand.`,
    ];
  }

  const { meta, warnings } = translateFumadocsMeta(parsed);
  const dir = dirname(rel) === "." ? "" : dirname(rel);
  if (Object.keys(meta).length > 0) {
    const dest = join(root, "docs", dir, "meta.ts");
    if (existsSync(dest)) {
      await rm(abs, { force: true });
      return [...warnings, `Skipped ${rel} (target already exists)`];
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(
      dest,
      `import { defineMeta } from "blume";\n\nexport default defineMeta(${JSON.stringify(meta, null, 2)});\n`,
      "utf-8"
    );
  }
  await rm(abs, { force: true });
  return warnings;
};

interface PageSummary {
  includeWarnings: string[];
  moved: number;
  removedKeys: string[];
  skipped: string[];
  unsupported: string[];
}

const summarizePages = (results: PageResult[]): PageSummary => {
  let moved = 0;
  const removedKeys = new Set<string>();
  const unsupported = new Set<string>();
  const includeWarnings: string[] = [];
  const skipped: string[] = [];
  for (const result of results) {
    moved += result.moved;
    if (result.skipped) {
      skipped.push(result.skipped);
    }
    includeWarnings.push(...result.includeWarnings);
    for (const key of result.removed) {
      removedKeys.add(key);
    }
    for (const name of result.unsupported) {
      unsupported.add(name);
    }
  }
  return {
    includeWarnings,
    moved,
    removedKeys: [...removedKeys],
    skipped,
    unsupported: [...unsupported],
  };
};

/** Remove `content/docs` and `content` once emptied; warn about leftovers. */
const cleanupSourceDirs = async (root: string): Promise<string[]> => {
  const docs = join(root, "content", "docs");
  if (existsSync(docs)) {
    const remaining = await glob(["**/*"], { cwd: docs, dot: true });
    if (remaining.length > 0) {
      return [
        `Kept ${remaining.length} non-page file(s) under content/docs; move them into docs/ manually.`,
      ];
    }
    await rm(docs, { force: true, recursive: true });
  }
  const content = join(root, "content");
  if (existsSync(content)) {
    const remaining = await glob(["**/*"], { cwd: content, dot: true });
    if (remaining.length === 0) {
      await rm(content, { force: true, recursive: true });
    }
  }
  return [];
};

/**
 * Migrate a Fumadocs project to Blume. Moves every `content/docs` page into
 * `docs/`, rewrites Fumadocs MDX (callouts to directives, `<Cards>`/
 * `<Accordions>`/`<Files>` to their Blume equivalents, `<Tabs items>` to
 * per-`<Tab>` titles, and `<include>`s inlined), and converts each `meta.json`
 * into a typed `meta.ts`. The `loader({ baseUrl })` route prefix is preserved
 * via a `content.sources` filesystem source.
 */
export const migrateFumadocsProject = async (
  root: string
): Promise<FumadocsMigrationResult> => {
  const { config, warnings: configWarnings } = await loadFumadocsConfig(root);

  const base = join(root, SOURCE_DIR);
  if (!existsSync(base)) {
    await writeBlumeConfig(root, config);
    return {
      moved: 0,
      warnings: [
        `No Fumadocs content directory (${SOURCE_DIR}) found; wrote a default config.`,
      ],
    };
  }

  const pageFiles = await glob([PAGE_GLOB], {
    absolute: true,
    cwd: base,
    ignore: IGNORE,
  });
  const metaFiles = await glob([META_GLOB], {
    absolute: true,
    cwd: base,
    ignore: IGNORE,
  });

  const pageResults = await Promise.all(
    pageFiles.map((abs) => movePage(abs, base, root))
  );
  const pages = summarizePages(pageResults);
  const metaResults = await Promise.all(
    metaFiles.map((abs) => convertMeta(abs, base, root))
  );
  const metaWarnings = metaResults.flat();

  await writeBlumeConfig(root, config);
  const cleanupWarnings = await cleanupSourceDirs(root);

  const warnings = [
    ...configWarnings,
    ...metaWarnings,
    ...pages.includeWarnings,
    ...pages.skipped.map((rel) => `Skipped ${rel} (target already exists)`),
    ...cleanupWarnings,
  ];
  if (pages.removedKeys.length > 0) {
    warnings.push(
      `Dropped unsupported page frontmatter keys: ${pages.removedKeys.join(", ")}.`
    );
  }
  if (pages.unsupported.length > 0) {
    warnings.push(
      `Components without a drop-in Blume equivalent need manual review: ${pages.unsupported.join(", ")}.`
    );
  }
  warnings.push("Review blume.config.ts and the generated meta.ts files.");

  return { moved: pages.moved, warnings };
};

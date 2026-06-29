import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import { dirname, join, relative } from "pathe";
import { glob } from "tinyglobby";

import type { BlumeConfig } from "../core/schema.ts";

export interface MigrationResult {
  moved: number;
  warnings: string[];
}

/** A Mintlify `navigation.languages[]` entry. */
interface MintlifyLanguage {
  language: string;
  default?: boolean;
}

/**
 * A display label for a locale code — the language's native name when the
 * runtime knows it (`fr` -> `Français`), else the code itself.
 */
const localeLabel = (code: string): string => {
  try {
    const native = new Intl.DisplayNames([code], { type: "language" }).of(code);
    if (native && native !== code) {
      return native.charAt(0).toUpperCase() + native.slice(1);
    }
  } catch {
    // Unknown code or no ICU data; fall through to the code.
  }
  return code;
};

/**
 * Map a Mintlify `navigation.languages[]` array to a Blume `i18n` config. The
 * entry marked `default: true` becomes `defaultLocale`; translated content
 * already lives in ISO-code directories, which match Blume's `dir` parser.
 */
const mintlifyI18n = (
  spec: Record<string, unknown>
): BlumeConfig["i18n"] | null => {
  const navigation = spec.navigation as
    | { languages?: MintlifyLanguage[] }
    | undefined;
  const languages = navigation?.languages;
  if (!Array.isArray(languages) || languages.length < 2) {
    return null;
  }
  const defaultLocale =
    languages.find((entry) => entry.default)?.language ??
    languages[0]?.language ??
    "en";
  return {
    defaultLocale,
    locales: languages.map((entry) => ({
      code: entry.language,
      label: localeLabel(entry.language),
    })),
  };
};

const writeBlumeConfig = async (
  root: string,
  config: BlumeConfig
): Promise<void> => {
  const body = `import { defineConfig } from "blume";\n\nexport default defineConfig(${JSON.stringify(config, null, 2)});\n`;
  await writeFile(join(root, "blume.config.ts"), body, "utf-8");
};

const META_JSON = /(?<sep>^|\/)meta\.json$/u;

/**
 * Convert a Fumadocs `meta.json` into a Blume `meta.ts` (`defineMeta`). On a
 * parse failure the raw file is moved as-is so its data isn't lost.
 */
const convertMetaFile = async (
  file: string,
  dir: string,
  rel: string
): Promise<string | null> => {
  const raw = await readFile(file, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const dest = join(dir, "meta.json");
    await mkdir(dirname(dest), { recursive: true });
    await rename(file, dest);
    return `Could not parse ${rel}; moved as-is — convert it to meta.ts by hand.`;
  }

  const dest = join(dir, "meta.ts");
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(
    dest,
    `import { defineMeta } from "blume";\n\nexport default defineMeta(${JSON.stringify(parsed, null, 2)});\n`
  );
  await rm(file);
  return null;
};

/** Move files into `docs/`, returning how many moved and any skips. */
const moveIntoDocs = async (
  root: string,
  absoluteFiles: string[],
  options: { from?: string; renameMeta?: boolean } = {}
): Promise<MigrationResult> => {
  const base = options.from ? join(root, options.from) : root;
  const warnings: string[] = [];
  let moved = 0;

  for (const file of absoluteFiles) {
    const rel = relative(base, file);

    if (options.renameMeta && META_JSON.test(rel)) {
      const targetTs = rel.replace(META_JSON, "$<sep>meta.ts");
      const destTs = join(root, "docs", targetTs);
      if (existsSync(destTs)) {
        warnings.push(`Skipped ${rel} (target already exists)`);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- sequential fs moves
      const warning = await convertMetaFile(file, dirname(destTs), rel);
      if (warning) {
        warnings.push(warning);
      }
      moved += 1;
      continue;
    }

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

/** Migrate a Mintlify project (mint.json / docs.json + MDX content). */
export const migrateMintlify = async (
  root: string
): Promise<MigrationResult> => {
  const configFile = existsSync(join(root, "docs.json"))
    ? join(root, "docs.json")
    : join(root, "mint.json");

  const warnings: string[] = [];
  let spec: Record<string, unknown> = {};
  if (existsSync(configFile)) {
    spec = JSON.parse(await readFile(configFile, "utf-8"));
  } else {
    warnings.push("No mint.json or docs.json found; using defaults.");
  }

  const files = await glob(["**/*.{md,mdx}"], {
    absolute: true,
    cwd: root,
    ignore: ["node_modules/**", "docs/**", ".blume/**", "dist/**"],
  });
  const result = await moveIntoDocs(root, files);

  const colors = spec.colors as { primary?: string } | undefined;
  const config: BlumeConfig = {
    title: (spec.name as string) ?? (spec.title as string) ?? "Documentation",
  };
  if (typeof spec.description === "string") {
    config.description = spec.description;
  }
  if (colors?.primary) {
    config.theme = { accent: colors.primary };
  }
  const i18n = mintlifyI18n(spec);
  if (i18n) {
    config.i18n = i18n;
  }
  await writeBlumeConfig(root, config);

  warnings.push(
    "Navigation is now inferred from files; add a meta.ts for custom ordering.",
    "Mintlify components (Card, Callout, Tabs, Steps, Accordion) map to Blume built-ins."
  );
  if (i18n) {
    warnings.push(
      `Mapped ${i18n.locales.length} languages to i18n.locales (default: ${i18n.defaultLocale}); review the locale labels.`
    );
  }

  return { moved: result.moved, warnings: [...result.warnings, ...warnings] };
};

const migrateFromContentDir = async (
  root: string,
  sourceDir: string,
  options: { title: string; renameMeta?: boolean }
): Promise<MigrationResult> => {
  if (!existsSync(join(root, sourceDir))) {
    return {
      moved: 0,
      warnings: [`Content directory ${sourceDir} not found.`],
    };
  }

  const patterns = options.renameMeta
    ? ["**/*.{md,mdx}", "**/meta.json"]
    : ["**/*.{md,mdx,mdoc}"];
  const files = await glob(patterns, {
    absolute: true,
    cwd: join(root, sourceDir),
  });
  const result = await moveIntoDocs(root, files, {
    from: sourceDir,
    renameMeta: options.renameMeta,
  });

  await writeBlumeConfig(root, { title: options.title });
  return result;
};

/** Migrate a Starlight project (src/content/docs). */
export const migrateStarlight = (root: string): Promise<MigrationResult> =>
  migrateFromContentDir(root, "src/content/docs", { title: "Documentation" });

/** Migrate a Fumadocs project (content/docs + meta.json). */
export const migrateFumadocs = (root: string): Promise<MigrationResult> =>
  migrateFromContentDir(root, "content/docs", {
    renameMeta: true,
    title: "Documentation",
  });

export const migrators: Record<
  string,
  (root: string) => Promise<MigrationResult>
> = {
  fumadocs: migrateFumadocs,
  mintlify: migrateMintlify,
  starlight: migrateStarlight,
};

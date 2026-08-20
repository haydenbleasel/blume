import { readFile } from "node:fs/promises";

import { dirname, join, relative } from "pathe";
import { glob } from "tinyglobby";

import { createModuleLoader } from "../core/load-module.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { folderMetaSchema } from "../core/schema.ts";
import type { FolderMeta } from "../core/schema.ts";
import type { Diagnostic } from "../core/types.ts";

/**
 * Folder-nav `meta.ts` titles are translatable under the `dir` parser ONLY:
 * per-locale meta is a whole-file replacement, not a merge (`applyFolderMeta`
 * looks up `<locale>/<group>` and falls back to shared meta, never to the
 * default locale's file), and the `dot` parser has no per-locale meta
 * mechanism at all. So the generated module must copy EVERY source key
 * (order/pages/icon/collapsed) with only the title translated — otherwise the
 * locale's navigation loses its ordering.
 */

/** One default-locale meta file whose title can be translated. */
export interface TranslatableMeta {
  /** The parsed meta module; copied wholesale into the generated module. */
  data: FolderMeta;
  /** Directory relative to the owning source's content root (`""` = root). */
  dir: string;
  /** Absolute path of the source meta file. */
  file: string;
  /** The owning source's content root (locale directories live under it). */
  contentRoot: string;
  /** Raw source text at discovery time — what the ledger hashes. */
  raw: string;
  /** POSIX root-relative path of the source meta file — the ledger key. */
  sourceRel: string;
  /** The source title to translate. */
  title: string;
}

const META_FILES = ["**/meta.ts", "**/meta.js", "**/meta.mjs"];

/**
 * Whether a loaded meta module default-exports a factory function. Generic so
 * it can decode the loader's untyped module value at this boundary.
 */
const isFactoryModule = <T>(
  value: T
): value is T & ((...args: never[]) => FolderMeta) =>
  typeof value === "function";

/** Where a locale's generated meta module lives (always written as `meta.ts`). */
export const metaTargetPath = (
  meta: TranslatableMeta,
  locale: string
): string => join(meta.contentRoot, locale, meta.dir, "meta.ts");

/**
 * Discover the default-locale `meta.{ts,js,mjs}` files whose titles a
 * translation run covers. Skips (in order): non-`dir` i18n projects entirely,
 * files inside a configured locale directory (those ARE translations),
 * factory-form modules (a warning — the generator can't re-emit a function),
 * modules that fail meta validation (the scan already errors on those), and
 * modules with no `title` (nothing to translate).
 */
export const discoverTranslatableMeta = async (
  project: BlumeProject
): Promise<{ metas: TranslatableMeta[]; diagnostics: Diagnostic[] }> => {
  const { i18n } = project.config;
  if (!i18n || i18n.parser !== "dir") {
    return { diagnostics: [], metas: [] };
  }
  const localeDirs = new Set(
    i18n.locales.flatMap((locale) =>
      locale.code === i18n.defaultLocale ? [] : [locale.code.toLowerCase()]
    )
  );

  const load = createModuleLoader();
  const metas: TranslatableMeta[] = [];
  const diagnostics: Diagnostic[] = [];

  const roots = project.sources.flatMap((source) =>
    source.staged || !source.contentRoot ? [] : [source.contentRoot]
  );
  for (const contentRoot of roots) {
    // oxlint-disable-next-line no-await-in-loop -- a project has O(1) sources
    const files = await glob(META_FILES, {
      absolute: true,
      cwd: contentRoot,
      ignore: ["**/node_modules/**", "**/.blume/**", "**/dist/**"],
      onlyFiles: true,
    });
    for (const file of files.toSorted()) {
      const dir = relative(contentRoot, dirname(file));
      const first = dir.split("/")[0]?.toLowerCase();
      if (first && localeDirs.has(first)) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- sequential, ordered discovery
      const [raw, mod] = await Promise.all([
        readFile(file, "utf-8"),
        load(file),
      ]);
      if (isFactoryModule(mod)) {
        diagnostics.push({
          code: "BLUME_TRANSLATE_META_FACTORY",
          file,
          message:
            "This meta file default-exports a function, so `blume translate` cannot generate per-locale copies of it.",
          severity: "warning",
          suggestion:
            "Export a plain object, or author the locale's meta file by hand.",
        });
        continue;
      }
      const parsed = folderMetaSchema.safeParse(mod);
      if (!parsed.success || parsed.data.title === undefined) {
        continue;
      }
      metas.push({
        contentRoot,
        data: parsed.data,
        dir: dir === "." ? "" : dir,
        file,
        raw,
        sourceRel: relative(project.context.root, file),
        title: parsed.data.title,
      });
    }
  }
  return { diagnostics, metas };
};

/**
 * Emit the per-locale meta module: every source key copied verbatim, only the
 * title swapped for its translation. Keys alphabetical, values as JSON.
 */
export const generateMetaModule = (
  meta: FolderMeta,
  translatedTitle: string
): string => {
  const data = {
    ...meta,
    title: translatedTitle,
  };
  const lines = Object.entries(data)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`);
  return [
    "// Generated by `blume translate` — edit the default locale's meta file",
    "// and rerun the translation instead of editing this copy.",
    "export default {",
    ...lines,
    "};",
    "",
  ].join("\n");
};

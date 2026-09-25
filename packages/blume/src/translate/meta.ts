import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { dirname, join, relative } from "pathe";

import { localeTargetPath } from "../core/i18n.ts";
import { createModuleLoader } from "../core/load-module.ts";
import { findFolderMetaFiles } from "../core/meta.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { folderMetaSchema } from "../core/schema.ts";
import type { FolderMeta, ResolvedI18nConfig } from "../core/schema.ts";
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

/** A folder's meta module names, in the order a lookup prefers them. */
const META_NAMES = ["meta.ts", "meta.js", "meta.mjs"];

const META_FILES = META_NAMES.map((name) => `**/${name}`);

/**
 * Whether a loaded meta module default-exports a factory function. Generic so
 * it can decode the loader's untyped module value at this boundary.
 */
const isFactoryModule = <T>(
  value: T
): value is T & ((...args: never[]) => FolderMeta) =>
  typeof value === "function";

/**
 * Where a locale's meta module lives. The locale folder is resolved the way
 * pages resolve it (`localeTargetPath`): `folders` are the content root's
 * existing top-level folders, and one naming the locale in another casing
 * (`pt-br/` for a configured `pt-BR`) is the locale's folder already. In that
 * folder, a `meta.js`/`meta.mjs` that already exists is the target — the
 * generated module is plain JavaScript, and writing a `meta.ts` beside it
 * would leave the folder with two meta files. Otherwise it's a new `meta.ts`.
 */
export const metaTargetPath = (
  meta: TranslatableMeta,
  locale: string,
  i18n: ResolvedI18nConfig,
  folders: readonly string[]
): string => {
  const dir = join(
    meta.contentRoot,
    dirname(
      localeTargetPath(join(meta.dir, "meta.ts"), ".ts", locale, i18n, folders)
    )
  );
  const existing = META_NAMES.find((name) => existsSync(join(dir, name)));
  return join(dir, existing ?? "meta.ts");
};

/**
 * Discover the default-locale `meta.{ts,js,mjs}` files whose titles a
 * translation run covers. Skips (in order): non-`dir` i18n projects entirely,
 * files the scan's own folder-meta discovery never reads either — those
 * matching the source's `exclude` globs (application code) or in folders its
 * `include` globs don't reach (see `findFolderMetaFiles`) — files inside a
 * configured locale directory (those ARE translations), files inside an
 * archived-version snapshot (frozen, with their own translations — the same
 * folders the navigation's meta lookup hoists as versions), modules that fail
 * to load (the scan already errors on those), factory-form modules (a warning
 * — the generator can't re-emit a function), modules that fail meta
 * validation (the scan already errors on those too), and modules with no
 * `title` (nothing to translate).
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
  const versionDirs = new Set(
    project.config.versions?.archived.map((version) => version.id)
  );

  const load = createModuleLoader();
  const metas: TranslatableMeta[] = [];
  const diagnostics: Diagnostic[] = [];

  const roots = project.sources.flatMap((source) =>
    source.staged || !source.contentRoot
      ? []
      : [
          {
            contentRoot: source.contentRoot,
            exclude: source.exclude,
            include: source.include,
          },
        ]
  );
  for (const { contentRoot, exclude, include } of roots) {
    // The scan's own file set (`discoverFolderMeta`): a `meta.ts` under an
    // excluded folder (`src/lib/meta.ts` beside `exclude: ["src/**"]`) is
    // application code, and one in a folder no `include` glob reaches
    // configures no group the build renders.
    // oxlint-disable-next-line no-await-in-loop -- a project has O(1) sources
    const files = await findFolderMetaFiles(
      { exclude, include, root: contentRoot },
      META_FILES
    );
    for (const file of files.toSorted()) {
      const dir = relative(contentRoot, dirname(file));
      const [head] = dir.split("/");
      if (
        head &&
        (localeDirs.has(head.toLowerCase()) || versionDirs.has(head))
      ) {
        continue;
      }
      let mod: Awaited<ReturnType<typeof load>>;
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential, ordered discovery
        mod = await load(file);
      } catch {
        // Folder meta that fails to load is the scan's BLUME_META_LOAD_FAILED
        // error, not a crash here; either way there's no title to read.
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- sequential, ordered discovery
      const raw = await readFile(file, "utf-8");
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

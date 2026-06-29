import { basename, dirname, relative } from "pathe";
import { glob } from "tinyglobby";

import { diagnosticsFromZod } from "./diagnostics.ts";
import { createModuleLoader } from "./load-module.ts";
import { folderMetaSchema } from "./schema.ts";
import type { FolderMeta } from "./schema.ts";
import type { Diagnostic } from "./types.ts";

const META_FILES = [
  "**/meta.ts",
  "**/meta.js",
  "**/meta.mjs",
  // Shared, locale-agnostic folder meta (applies to every locale).
  "**/meta.$.ts",
  "**/meta.$.js",
  "**/meta.$.mjs",
];

/** Resolve a meta module's default export, calling it if it is a factory. */
const resolveMeta = async (mod: unknown): Promise<unknown> =>
  typeof mod === "function" ? await (mod as () => unknown)() : mod;

/**
 * Discover `meta.{ts,js,mjs}` files under the content root. Keys are the
 * directory path relative to the content root (`""` for the root directory).
 * `meta.$.*` files are returned in `shared` — folder meta that applies to that
 * directory in every locale (a locale-specific `meta.*` overrides it). Each file
 * default-exports an object or a (sync/async) function returning one.
 */
export const discoverFolderMeta = async (
  contentRoot: string
): Promise<{
  meta: Map<string, FolderMeta>;
  shared: Map<string, FolderMeta>;
  diagnostics: Diagnostic[];
}> => {
  const files = await glob(META_FILES, {
    absolute: true,
    cwd: contentRoot,
    onlyFiles: true,
  });

  const load = createModuleLoader();
  const loaded = await Promise.all(
    files.map(
      async (
        file
      ): Promise<
        | { ok: true; file: string; value: unknown }
        | { ok: false; file: string; error: Error }
      > => {
        try {
          return { file, ok: true, value: await resolveMeta(await load(file)) };
        } catch (error) {
          return { error: error as Error, file, ok: false };
        }
      }
    )
  );

  const meta = new Map<string, FolderMeta>();
  const shared = new Map<string, FolderMeta>();
  const diagnostics: Diagnostic[] = [];

  for (const entry of loaded) {
    const dir = relative(contentRoot, dirname(entry.file));

    if (!entry.ok) {
      diagnostics.push({
        code: "BLUME_META_LOAD_FAILED",
        file: entry.file,
        message: `Could not load meta file: ${entry.error.message}`,
        severity: "error",
      });
      continue;
    }

    const result = folderMetaSchema.safeParse(entry.value);
    if (result.success) {
      const target = basename(entry.file).startsWith("meta.$.") ? shared : meta;
      target.set(dir, result.data);
    } else {
      diagnostics.push(
        ...diagnosticsFromZod(result.error, {
          code: "BLUME_META_INVALID",
          file: entry.file,
        })
      );
    }
  }

  return { diagnostics, meta, shared };
};

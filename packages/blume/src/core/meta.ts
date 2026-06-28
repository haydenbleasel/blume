import { readFile } from "node:fs/promises";

import { basename, dirname, relative } from "pathe";
import { glob } from "tinyglobby";
import { parse as parseYaml } from "yaml";

import { diagnosticsFromZod } from "./diagnostics.ts";
import { folderMetaSchema } from "./schema.ts";
import type { FolderMeta } from "./schema.ts";
import type { Diagnostic } from "./types.ts";

const META_FILES = [
  "**/_meta.json",
  "**/_meta.yaml",
  "**/_meta.yml",
  // Shared, locale-agnostic folder meta (applies to every locale).
  "**/_meta.$.json",
  "**/_meta.$.yaml",
  "**/_meta.$.yml",
];

/**
 * Discover `_meta.{json,yaml}` files under the content root. Keys are the
 * directory path relative to the content root (`""` for the root directory).
 * `_meta.$.*` files are returned in `shared` — folder meta that applies to that
 * directory in every locale (a locale-specific `_meta.*` overrides it).
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

  const sources = await Promise.all(
    files.map(async (file) => ({ file, raw: await readFile(file, "utf-8") }))
  );

  const meta = new Map<string, FolderMeta>();
  const shared = new Map<string, FolderMeta>();
  const diagnostics: Diagnostic[] = [];

  for (const { file, raw } of sources) {
    const dir = relative(contentRoot, dirname(file));

    let data: unknown;
    try {
      data = file.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
    } catch (error) {
      diagnostics.push({
        code: "BLUME_META_PARSE_ERROR",
        file,
        message: `Could not parse meta file: ${(error as Error).message}`,
        severity: "error",
      });
      continue;
    }

    const result = folderMetaSchema.safeParse(data);
    if (result.success) {
      const target = basename(file).startsWith("_meta.$.") ? shared : meta;
      target.set(dir, result.data);
    } else {
      diagnostics.push(
        ...diagnosticsFromZod(result.error, {
          code: "BLUME_META_INVALID",
          file,
        })
      );
    }
  }

  return { diagnostics, meta, shared };
};

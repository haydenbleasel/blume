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

/** A filesystem content source to scan for folder meta: its on-disk root and
 * optional route prefix. The prefix is folded into every key so meta lines up
 * with the sidebar group path, which carries the same prefix. */
export interface FolderMetaSource {
  root: string;
  prefix?: string;
}

/**
 * The folder-meta key for a directory. Mirrors the sidebar group path: the
 * source's route prefix (`docs`) followed by the directory relative to the
 * source root (`provider`) — so `docs/provider/meta.ts` under a `prefix: "docs"`
 * source keys to `docs/provider`, exactly the group path navigation builds.
 */
const metaKeyFor = (prefix: string | undefined, dir: string): string => {
  const clean = prefix ? prefix.replaceAll(/^\/+|\/+$/gu, "") : "";
  if (!clean) {
    return dir;
  }
  return dir ? `${clean}/${dir}` : clean;
};

/**
 * Discover `meta.{ts,js,mjs}` files across the given filesystem sources. Keys are
 * the source's route prefix joined with the directory relative to that source's
 * root (`""`/the prefix itself for a source's root directory), so meta matches
 * the prefixed sidebar group path. A bare string is shorthand for a single,
 * unprefixed source (the default project layout). `meta.$.*` files are returned
 * in `shared` — folder meta that applies to that directory in every locale (a
 * locale-specific `meta.*` overrides it). Each file default-exports an object or
 * a (sync/async) function returning one.
 *
 * `localeDirs` names the top-level locale directories of a `dir`-parser i18n
 * project. Navigation looks locale meta up as `locale/<group path>` where the
 * group path starts with the source prefix, so a locale directory found at a
 * source root is hoisted in front of the prefix (`docs/fr/guides/meta.ts` keys
 * to `fr/docs/guides`, not `docs/fr/guides`).
 */
export const discoverFolderMeta = async (
  sources: string | FolderMetaSource[],
  options: { localeDirs?: readonly string[] } = {}
): Promise<{
  meta: Map<string, FolderMeta>;
  shared: Map<string, FolderMeta>;
  diagnostics: Diagnostic[];
}> => {
  const list: FolderMetaSource[] =
    typeof sources === "string" ? [{ root: sources }] : sources;
  const localeDirs = new Set(options.localeDirs);

  const load = createModuleLoader();
  const meta = new Map<string, FolderMeta>();
  const shared = new Map<string, FolderMeta>();
  const diagnostics: Diagnostic[] = [];

  // Scan every source under its own root so a source rooted outside
  // `content.root` still contributes its folder meta.
  const perSource = await Promise.all(
    list.map(async (source) => {
      const files = await glob(META_FILES, {
        absolute: true,
        cwd: source.root,
        // Never descend into dependencies or build output — relevant when the
        // root is the project root (e.g. a `.`-rooted or all-staged project).
        ignore: ["**/node_modules/**", "**/.blume/**", "**/dist/**"],
        onlyFiles: true,
      });
      const loaded = await Promise.all(
        files.map(
          async (
            file
          ): Promise<
            | { ok: true; file: string; value: unknown }
            | { ok: false; file: string; error: Error }
          > => {
            try {
              return {
                file,
                ok: true,
                value: await resolveMeta(await load(file)),
              };
            } catch (error) {
              return { error: error as Error, file, ok: false };
            }
          }
        )
      );
      return { loaded, source };
    })
  );

  for (const { loaded, source } of perSource) {
    for (const entry of loaded) {
      const dir = relative(source.root, dirname(entry.file));
      const [head, ...tail] = dir.split("/");
      // A locale directory sits between the source root and the folder, but the
      // lookup key carries the locale in front of the (prefixed) group path.
      const key =
        head && localeDirs.has(head)
          ? `${head}/${metaKeyFor(source.prefix, tail.join("/"))}`.replace(
              /\/$/u,
              ""
            )
          : metaKeyFor(source.prefix, dir);

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
        const target = basename(entry.file).startsWith("meta.$.")
          ? shared
          : meta;
        target.set(key, result.data);
      } else {
        diagnostics.push(
          ...diagnosticsFromZod(result.error, {
            code: "BLUME_META_INVALID",
            file: entry.file,
          })
        );
      }
    }
  }

  return { diagnostics, meta, shared };
};

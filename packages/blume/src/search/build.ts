import { mkdir, writeFile } from "node:fs/promises";

import { close, createIndex } from "pagefind";
import { dirname, join } from "pathe";

/** The part of `pagefind-entry.json` that counts the index's pages. */
interface PagefindEntry {
  languages: Record<string, { page_count: number }>;
}

/**
 * Build a local Pagefind search index over the built site. Pagefind indexes
 * every rendered page except those whose `<html>` carries
 * `data-pagefind-ignore`, which Blume stamps on non-indexable pages
 * (search-excluded, or hidden without the opt-in), so those stay out.
 *
 * Pagefind is imported statically, not with `import()`: this runs in the
 * `astro:build:done` hook, after Astro has closed the module runner an
 * installed Blume's config was evaluated in (see `core/node-require.ts`), and
 * Pagefind ships only an `import` export, so `require` can't load it either.
 *
 * The index files are fetched with `getFiles()` and written here rather than
 * with Pagefind's `writeFiles()`: in service mode Pagefind acknowledges
 * `writeFiles()` once tokio has buffered the writes, not once they are on
 * disk, and `close()` kills the backend, so a loaded CI host can ship a
 * truncated `pagefind-entry.json` (Pagefind/pagefind#1271). Writing the bytes
 * ourselves puts them on disk before the backend goes away. Fixed upstream in
 * Pagefind/pagefind#1272; switch back to `writeFiles()` once a release ships
 * that fix.
 *
 * Returns the number of pages indexed: the index's own count, summed over its
 * languages from `pagefind-entry.json`. `addDirectory`'s `page_count` counts
 * every HTML file it read, including the ones kept out of the index.
 */
export const buildSearchIndex = async (outDir: string): Promise<number> => {
  const { index } = await createIndex({});
  if (!index) {
    throw new Error("Failed to create Pagefind index.");
  }

  // These awaits are strictly ordered, not independent: the directory must be
  // indexed before its files are read, and the index closed only after.
  // oxlint-disable-next-line react-doctor/async-parallel
  await index.addDirectory({ path: outDir });
  const { files } = await index.getFiles();
  await close();

  const searchDir = join(outDir, "pagefind");
  const directories = new Set(
    files.map((file) => dirname(join(searchDir, file.path)))
  );
  await Promise.all(
    [...directories].map((directory) => mkdir(directory, { recursive: true }))
  );
  await Promise.all(
    files.map((file) => writeFile(join(searchDir, file.path), file.content))
  );

  // Pagefind always writes the entry file, listing no languages when nothing
  // was indexed.
  const entry = files.find((file) => file.path === "pagefind-entry.json");
  // SAFETY: the entry file is Pagefind's JSON, which counts each language's
  // pages in `page_count`.
  const { languages } = JSON.parse(
    new TextDecoder().decode(entry?.content)
  ) as PagefindEntry;
  return Object.values(languages).reduce(
    (sum, language) => sum + language.page_count,
    0
  );
};

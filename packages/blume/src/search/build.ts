import { join } from "pathe";

/**
 * Build a local Pagefind search index over the built site. Pagefind indexes
 * every rendered page except those whose `<html>` carries
 * `data-pagefind-ignore`, which Blume stamps on non-indexable pages
 * (search-excluded, or hidden without the opt-in), so those stay out.
 *
 * Returns the number of pages indexed.
 */
export const buildSearchIndex = async (outDir: string): Promise<number> => {
  const pagefind = await import("pagefind");

  const { index } = await pagefind.createIndex({});
  if (!index) {
    throw new Error("Failed to create Pagefind index.");
  }

  // These awaits are strictly ordered, not independent: the directory must be
  // indexed before its files are written, and the index closed only after.
  // oxlint-disable-next-line react-doctor/async-parallel
  const result = await index.addDirectory({ path: outDir });
  await index.writeFiles({ outputPath: join(outDir, "pagefind") });
  await pagefind.close();

  return result.page_count;
};

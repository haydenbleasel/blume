import { readFile } from "node:fs/promises";

import type { PageRecord } from "../types.ts";
import type { ContentSource } from "./types.ts";

/** The subset of a scanned project the entry reader needs. */
export interface EntryReadContext {
  /** The instantiated sources, keyed for `read()` lookups. */
  sources?: ContentSource[];
}

/**
 * Read an entry's raw body text without assuming a filesystem path. Prefers the
 * body captured at scan time (staged sources), then the owning source's lazy
 * `read()`, then the back-compat `sourcePath` (filesystem). Returns `""` when an
 * entry can't be resolved, so callers degrade gracefully.
 */
export const readEntryText = async (
  ctx: EntryReadContext,
  page: PageRecord
): Promise<string> => {
  if (page.body) {
    return page.body.text;
  }
  const name = page.source?.name;
  const source = name
    ? ctx.sources?.find((candidate) => candidate.name === name)
    : undefined;
  if (source?.read) {
    return await source.read(page.source.ref);
  }
  if (page.sourcePath) {
    return await readFile(page.sourcePath, "utf-8");
  }
  return "";
};

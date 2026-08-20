import { readFile } from "node:fs/promises";

import { expandIncludes, hasIncludeStatements } from "../includes.ts";
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

/**
 * Read an entry's raw body with `<include>` statements expanded — what search
 * indexing, the `.md`/`.mdx` mirrors, and llms-full.txt should see, matching
 * the spliced content the rendered page shows. Filesystem entries only
 * (includes resolve as filesystem paths); everything else passes through
 * verbatim. Expansion errors were already surfaced as scan diagnostics, so
 * unresolvable statements simply stay verbatim here.
 */
export const readExpandedEntryText = async (
  ctx: EntryReadContext,
  page: PageRecord
): Promise<string> => {
  const raw = await readEntryText(ctx, page);
  if (!(page.sourcePath && hasIncludeStatements(raw))) {
    return raw;
  }
  const source = ctx.sources?.find(
    (candidate) => candidate.name === page.source.name
  );
  const expansion = await expandIncludes(raw, {
    contentRoot: source?.contentRoot,
    sourcePath: page.sourcePath,
  });
  return expansion.text;
};

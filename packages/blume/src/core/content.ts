import type { ResolvedI18nConfig } from "./schema.ts";
import { filesystemSource } from "./sources/filesystem.ts";
import { normalizeEntry } from "./sources/normalize.ts";
import type { Diagnostic, PageRecord } from "./types.ts";

// Re-export the shared parsing helpers from their new home so existing importers
// (and tests) keep resolving them from `core/content.ts`.
export {
  extractHeadings,
  extractLinks,
  normalizeEntry,
  slugify,
} from "./sources/normalize.ts";

/**
 * Discover and normalize all content pages under a content root. Thin wrapper
 * around the filesystem `ContentSource` + `normalizeEntry`, kept for callers and
 * tests that scan a single directory directly.
 */
export const discoverContent = async (options: {
  contentRoot: string;
  include: string[];
  exclude: string[];
  defaultType: string;
  i18n?: ResolvedI18nConfig;
}): Promise<{ pages: PageRecord[]; diagnostics: Diagnostic[] }> => {
  const source = filesystemSource({
    exclude: options.exclude,
    include: options.include,
    name: "filesystem",
    projectRoot: options.contentRoot,
    root: options.contentRoot,
  });

  const { entries, diagnostics: loadDiagnostics } = await source.load();
  const pages: PageRecord[] = [];
  const diagnostics: Diagnostic[] = [...loadDiagnostics];

  for (const entry of entries) {
    const normalized = normalizeEntry(entry, {
      defaultType: options.defaultType,
      i18n: options.i18n,
      source: { name: source.name, prefix: source.prefix, staged: false },
    });
    pages.push(...normalized.pages);
    diagnostics.push(...normalized.diagnostics);
  }

  return { diagnostics, pages };
};

import type { ResolvedConfig } from "../core/schema.ts";
import type { PageRecord } from "../core/types.ts";

/**
 * Resolve a page's facet values: the subset of its validated custom
 * frontmatter named by its content type's `facets` declaration. Strings facet
 * as-is; numbers and booleans are stringified so an enum-like `priority: 1`
 * or `enforced: true` still filters; any other shape (objects, arrays,
 * transformed dates) is not a facet value and is skipped. Returns `undefined`
 * when nothing facets, so the field stays absent from serialized documents
 * rather than shipping as `{}` on every page.
 */
export const pageFacets = (
  page: Pick<PageRecord, "contentType" | "custom">,
  config: ResolvedConfig
): Record<string, string> | undefined => {
  const declared = config.content.types[page.contentType]?.facets;
  if (!declared || declared.length === 0 || !page.custom) {
    return;
  }
  const facets: Record<string, string> = {};
  for (const key of declared) {
    const value = page.custom[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      facets[key] = String(value);
    }
  }
  return Object.keys(facets).length > 0 ? facets : undefined;
};

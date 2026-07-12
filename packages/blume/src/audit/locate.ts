import { locateFrontmatterKey } from "../core/diagnostics.ts";
import type { FindingSite } from "./catalog.ts";
import type { AuditContext, PageSnapshot } from "./types.ts";

/**
 * Where to report a finding about `page`: the built URL, plus — when the page
 * came from authored content — the source file and the exact front matter line
 * to edit.
 *
 * This is the feature. A crawler can only tell you that `/docs/api` has no
 * description; Blume knows the page was built from `docs/api.mdx` and can put
 * the cursor on the line. Pass the front matter key path a fix would touch
 * (`["description"]`, `["seo", "canonical"]`); omit it when the key doesn't
 * exist yet, and the finding anchors to the file instead.
 */
export const pageSite = (
  context: AuditContext,
  page: PageSnapshot,
  key?: readonly (string | number)[]
): FindingSite => {
  const file = page.source;
  if (!file) {
    return { url: page.url };
  }
  const source = key ? context.sources.get(file) : undefined;
  const position = source ? locateFrontmatterKey(source, key ?? []) : undefined;
  return {
    column: position?.column,
    file,
    line: position?.line,
    url: page.url,
  };
};

import type { UIStrings } from "./i18n-ui.ts";
import { resolveLocalizable } from "./localizable.ts";
import type { LocalizableLabel, ResolvedConfig } from "./schema.ts";
import { sourcesOfKind } from "./sources/collection.ts";
import type { PageRecord } from "./types.ts";

/** Where the changelog timeline index is served. */
export const CHANGELOG_INDEX_ROUTE = "/changelog";

/**
 * Whether the site serves a changelog index at {@link CHANGELOG_INDEX_ROUTE}:
 * there are visible `type: changelog` entries, or a release-backed source
 * (whose index must resolve even when a fetch fails). Blume generates the
 * timeline there unless a custom or content page already owns the route —
 * either way the route is servable, which is what navigation needs to point a
 * `/changelog` tab at the index rather than its newest entry.
 */
export const hasChangelogIndex = (
  pages: Pick<PageRecord, "contentType" | "meta">[],
  config: ResolvedConfig
): boolean =>
  pages.some(
    (page) =>
      page.contentType === "changelog" &&
      !(page.meta.draft || page.meta.sidebar.hidden)
  ) || sourcesOfKind(config, "github-releases").length > 0;

/**
 * A locale's UI strings with the index's title and description taken from
 * the `changelog` config where it sets them (a string, or a per-locale map
 * resolved like a header label), so every surface that reads the
 * `changelog` strings (the page, its OG card, its Markdown mirror) agrees.
 */
export const withChangelogIndexText = (
  config: ResolvedConfig,
  ui: UIStrings,
  locale?: string
): UIStrings => {
  const text = (label: LocalizableLabel | undefined, fallback: string) =>
    label === undefined
      ? fallback
      : resolveLocalizable(label, locale, config.i18n?.defaultLocale);
  return {
    ...ui,
    changelog: {
      ...ui.changelog,
      description: text(
        config.changelog?.description,
        ui.changelog.description
      ),
      title: text(config.changelog?.title, ui.changelog.title),
    },
  };
};

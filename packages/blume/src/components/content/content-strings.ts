import { EN_UI } from "../../core/i18n-ui.ts";
import type { UIStrings } from "../../core/i18n-ui.ts";

/** The `blume:data` fields a content component resolves its labels from. */
export interface ContentStringsData {
  config: { i18n: object | null };
  ui: UIStrings;
  uiByLocale: Record<string, UIStrings>;
}

/** The UI string groups a content component's chrome reads. */
export type ContentStrings = Pick<
  UIStrings,
  "actions" | "blog" | "changelog" | "content"
>;

/**
 * Labels for a component rendered inside page content (MDX), which gets no
 * strings prop from the layout the way chrome components do: the dictionary of
 * the locale Astro resolved for the URL (`Astro.currentLocale`, the page's own
 * locale — a fallback page included, matching its chrome), else the site
 * default. Merged over the English baseline per group, so a key a translation
 * lacks still renders instead of coming out blank.
 */
export const contentStrings = (
  data: ContentStringsData,
  currentLocale?: string
): ContentStrings => {
  const dictionary =
    data.config.i18n && currentLocale
      ? (data.uiByLocale[currentLocale] ?? data.ui)
      : data.ui;
  return {
    actions: { ...EN_UI.actions, ...dictionary.actions },
    blog: { ...EN_UI.blog, ...dictionary.blog },
    changelog: { ...EN_UI.changelog, ...dictionary.changelog },
    content: { ...EN_UI.content, ...dictionary.content },
  };
};

import { EN_UI } from "../../core/i18n-ui.ts";
import type { UIStrings } from "../../core/i18n-ui.ts";
import type { ContentStringsData } from "../content/content-strings.ts";

/**
 * The API reference's labels, plus the `deprecated` badge it shares with the
 * sidebar.
 */
export type ReferenceStrings = UIStrings["reference"] &
  Pick<UIStrings["nav"], "deprecated">;

// One merged object per dictionary: a large reference page renders thousands
// of schema rows, and each resolves its labels.
const merged = new WeakMap<UIStrings, ReferenceStrings>();

/**
 * Labels for an API reference component, which renders inside page content and
 * so gets no strings prop from the layout: the dictionary of the locale Astro
 * resolved for the URL (a fallback page's included, matching its chrome), else
 * the site default, as `contentStrings` picks it. Merged over the English
 * baseline, so a key a translation lacks still renders.
 */
export const referenceStrings = (
  data: ContentStringsData,
  currentLocale?: string
): ReferenceStrings => {
  const dictionary =
    data.config.i18n && currentLocale
      ? (data.uiByLocale[currentLocale] ?? data.ui)
      : data.ui;
  let strings = merged.get(dictionary);
  if (!strings) {
    strings = {
      ...EN_UI.reference,
      ...dictionary.reference,
      deprecated: dictionary.nav.deprecated || EN_UI.nav.deprecated,
    };
    merged.set(dictionary, strings);
  }
  return strings;
};

/**
 * A label's text either side of `placeholder`, for a value that renders as
 * markup (a `<code>` name, a link). A translation that drops the placeholder
 * keeps its text in front, so the value still follows it.
 */
export const aroundPlaceholder = (
  template: string,
  placeholder: string
): [string, string] => {
  const at = template.indexOf(placeholder);
  return at === -1
    ? [template, ""]
    : [template.slice(0, at), template.slice(at + placeholder.length)];
};

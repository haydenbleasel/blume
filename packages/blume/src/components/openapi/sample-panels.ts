import type { CodeThemes } from "../../markdown/index.ts";
import { highlightCode } from "../../markdown/index.ts";

/**
 * The Request-tab rendering shared by the operation renderers (OpenAPI's
 * `RequestPanel`, `AsyncApiOperation`, `GraphqlOperation`): one highlighted
 * panel per code-sample language, so the panel shape and highlight options
 * can't drift between the three. Kept apart from `snippets.ts`, which must
 * stay dependency-free for the browser playground client — this module pulls
 * in Shiki.
 */

/** One rendered tab: highlighted HTML plus the `PanelTabs` metadata. */
export interface SamplePanel {
  html: string;
  key: string;
  label: string;
  lang: string;
}

/** The shape `SampleLanguage` and `AsyncSampleLanguage` share. */
interface PanelLanguage<Sample> {
  id: string;
  label: string;
  lang: string;
  build: (sample: Sample) => string;
}

/** Render one highlighted panel per language for a built request sample. */
export const languageSamplePanels = <Sample>(
  languages: PanelLanguage<Sample>[],
  sample: Sample,
  themes: CodeThemes
): Promise<SamplePanel[]> =>
  Promise.all(
    languages.map(async (language) => ({
      html: await highlightCode(language.build(sample), language.lang, {
        icons: false,
        themes,
      }),
      key: language.id,
      label: language.label,
      lang: language.id,
    }))
  );

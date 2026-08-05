import type { LocaleConfig } from "../core/schema.ts";

/**
 * The frontmatter key paths whose *values* an agent may translate. Everything
 * else in the frontmatter is copied from the source verbatim by the validator,
 * so this list is both the prompt's instruction and the reconciliation
 * contract in `validate.ts`.
 */
export const TRANSLATABLE_KEY_PATHS: readonly (readonly string[])[] = [
  ["title"],
  ["description"],
  ["sidebar", "label"],
  ["sidebar", "badge"],
  ["seo", "title"],
  ["seo", "description"],
];

/** "French (fr)" — the configured display label plus the code. */
const localeName = (locale: LocaleConfig): string =>
  `${locale.label} (${locale.code})`;

const KEY_LIST = TRANSLATABLE_KEY_PATHS.map((path) => path.join(".")).join(
  ", "
);

/**
 * The page-translation prompt. Delivered over stdin (no argv limits), so the
 * full source file rides along inline. When the page was translated before,
 * the previous translation rides along too: without it, every retranslation
 * is a from-scratch rewrite in which the agent re-decides register, dialect,
 * and terminology (du vs Sie, pt-BR vs pt-PT) and churns the whole page for
 * a one-paragraph source edit.
 */
export const pagePrompt = (
  sourceText: string,
  target: LocaleConfig,
  source: LocaleConfig,
  previousTranslation?: string
): string => {
  const styleRule =
    target.style === undefined
      ? ""
      : `
- Write the translation in this style: ${target.style}`;
  const previousRule =
    previousTranslation === undefined
      ? ""
      : `
- A translation of an earlier revision of this page is included below. Match its register, formality, dialect, and terminology exactly; re-translate only what the changed source requires and keep everything else word-for-word identical.${
          target.style === undefined
            ? ""
            : " Where the previous translation disagrees with the style rule above, the style rule wins."
        }`;
  const previousSection =
    previousTranslation === undefined
      ? ""
      : `
The previous translation begins after this line and ends at the "page source" marker.
${previousTranslation}`;
  return `Translate the following documentation page from ${localeName(
    source
  )} into ${localeName(target)}.

Rules:
- Translate the prose: headings, paragraphs, list items, table cells, admonitions, and image alt text.
- In the YAML frontmatter, translate ONLY the values of these keys: ${KEY_LIST}. Copy every other frontmatter key and value exactly as written.
- Never translate or alter: code blocks, inline code, import/export statements, JSX/MDX component names and their attributes, URLs, link targets, HTML tags, or frontmatter keys.
- Preserve the document structure exactly: the same headings, the same lists and tables, and the same number of code fences.${styleRule}${previousRule}
- Output ONLY the complete translated file. Do not wrap it in a code fence. Do not add commentary before or after it.
${previousSection}
The page source begins after this line.
${sourceText}`;
};

/**
 * The sidebar-titles prompt: a JSON object of `{directory: title}` in, the
 * same keys with translated values out.
 */
export const metaPrompt = (
  titles: Record<string, string>,
  target: LocaleConfig,
  source: LocaleConfig
): string => `Translate the following documentation sidebar section titles from ${localeName(
  source
)} into ${localeName(target)}.

The input is a JSON object mapping a directory path to its title. Reply with ONLY a JSON object that has exactly the same keys, where each value is the title translated into ${localeName(
  target
)}. Do not translate the keys. Do not add commentary.${
  target.style === undefined
    ? ""
    : `\nWrite the titles in this style: ${target.style}`
}

${JSON.stringify(titles, null, 2)}`;

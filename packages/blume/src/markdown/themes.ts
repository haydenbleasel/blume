/**
 * The light/dark Shiki themes Blume highlights code with. Every Shiki surface —
 * fenced code (the generated Astro `shikiConfig.themes`), inline `` `code`{:lang} ``,
 * out-of-pipeline `highlightCode`, and `<Diff>` — resolves to the same pair so a
 * project's `markdown.codeBlocks.theme` shifts them all in lockstep. This is the
 * single home for the github fallback used when nothing is configured.
 */

/**
 * A light/dark Shiki theme pair (`markdown.codeBlocks.theme`). A `type` (not an
 * `interface`) so it keeps the implicit index signature Shiki's `themes`
 * parameter (`Partial<Record<string, …>>`) expects.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- interface loses the implicit index signature Shiki's `themes` param needs
export type CodeThemes = {
  dark: string;
  light: string;
};

/** The default pair, used when `markdown.codeBlocks.theme` is unset. */
export const DEFAULT_CODE_THEMES: CodeThemes = {
  dark: "github-dark",
  light: "github-light",
};

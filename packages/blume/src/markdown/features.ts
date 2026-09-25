import type { Features } from "satteri";

/**
 * Sätteri's feature set for plain `.md` pages. Shared by the renderer and the
 * search extractor so the index reads the same grammar the page renders.
 */
export const MARKDOWN_FEATURES = {
  subscript: true,
  superscript: true,
} satisfies Features;

/**
 * The `.mdx` feature set: Markdown's plus `:::` directives (→ `<Callout>`) and
 * block-only math — `singleDollarTextMath: false` keeps a bare `$` (currency,
 * shell, code) as literal text and only parses `$$…$$`.
 */
export const MDX_FEATURES = {
  ...MARKDOWN_FEATURES,
  directive: true,
  math: { singleDollarTextMath: false },
} satisfies Features;

/**
 * The feature sets for a page body, once its front matter is off. Astro reads
 * a page's front matter itself and hands the renderer the body alone, and the
 * search extractor strips it first too — so front matter parsing is off here:
 * left on, a body that opens with a `---` rule read everything up to the next
 * `---` line as front matter and dropped it from the page.
 */
export const MARKDOWN_BODY_FEATURES = {
  ...MARKDOWN_FEATURES,
  frontmatter: false,
} satisfies Features;

export const MDX_BODY_FEATURES = {
  ...MDX_FEATURES,
  frontmatter: false,
} satisfies Features;

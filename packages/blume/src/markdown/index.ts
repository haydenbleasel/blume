import { satteri } from "@astrojs/markdown-satteri";
import {
  transformerMetaHighlight,
  transformerNotationDiff,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";

import { codeTitleTransformer } from "./code-title.ts";
import { directiveToCalloutPlugin } from "./directives.ts";
import { headingAnchorPlugin } from "./heading-anchors.ts";
import { inlineCodeHighlightPlugin } from "./inline-code.ts";
import { languageIconTransformer } from "./language-icon.ts";
import { mathPlugin } from "./math.ts";
import { mermaidPlugin } from "./mermaid.ts";
import { mintlifyCodeGroupPlugin } from "./mintlify-code-group.ts";
import { mintlifySvgIconPlugin } from "./mintlify-svg-icons.ts";
import { packageInstallPlugin } from "./package-install.ts";

/** A Shiki transformer, derived from the upstream factories' return type. */
type ShikiTransformer = ReturnType<typeof transformerNotationDiff>;

export {
  PACKAGE_MANAGERS,
  type PackageManager,
  toPackageCommands,
} from "./package-commands.ts";
export {
  type CodeTitleTransformer,
  codeTitleTransformer,
} from "./code-title.ts";
export { calloutTypeFor } from "./directives.ts";
export { headingAnchorPlugin } from "./heading-anchors.ts";
export { mermaidPlugin } from "./mermaid.ts";
export { mintlifyCodeGroupPlugin } from "./mintlify-code-group.ts";
export {
  mintlifySvgIconPlugin,
  rewriteMintlifySvgIconProps,
} from "./mintlify-svg-icons.ts";
export {
  rewriteMintlifyGlobalVariables,
  rewriteMintlifyMarkdownSnippets,
  rewriteMintlifySnippetVariables,
  rewriteMintlifyUserVariable,
} from "./mintlify-snippets.ts";
export { packageInstallPlugin } from "./package-install.ts";

/** Element type of Satteri's `mdastPlugins`, sourced from the (alpha) core. */
type MdastPlugin = NonNullable<
  NonNullable<Parameters<typeof satteri>[0]>["mdastPlugins"]
>[number];

/** Element type of Satteri's `hastPlugins`. */
type HastPlugin = NonNullable<
  NonNullable<Parameters<typeof satteri>[0]>["hastPlugins"]
>[number];

/**
 * Hast plugins enabled by config. Inline `` `code`{:lang} `` highlighting is
 * opt-in; self-linking heading anchors (`<h2>`–`<h6>` wrapped in an `<a>` to
 * their own id) are on unless `markdown.headingAnchors` is `false`. Inline code
 * runs first so the anchor wrap re-refs already-highlighted code.
 */
const blumeHastPlugins = (options: BlumeMarkdownOptions): HastPlugin[] => {
  const plugins: HastPlugin[] = [];
  if (options.inline) {
    plugins.push(inlineCodeHighlightPlugin() as unknown as HastPlugin);
  }
  if (options.headingAnchors !== false) {
    plugins.push(headingAnchorPlugin() as unknown as HastPlugin);
  }
  return plugins;
};

/**
 * Shiki transformers enabled by default for every code block. The four upstream
 * notation transformers read GitHub-style comments and strip them from the
 * output: `// [!code highlight]`, `// [!code ++]` / `// [!code --]`,
 * `// [!code word:x]`, and `// [!code focus]`. The v3 match algorithm scopes a
 * notation to the line it sits on (or the next, for a trailing comment).
 * `transformerMetaHighlight` adds numeric range highlighting from the fence meta
 * (` ```ts {1,3-5} `), reusing the same `highlighted` class. Blume's own
 * {@link languageIconTransformer} prepends a brand icon, and
 * {@link codeTitleTransformer} runs last to promote fence-meta (title / line
 * numbers) to `<pre>` attributes. The theme styles the classes these emit
 * (`highlighted`, `diff add/remove`, `highlighted-word`, `focused`,
 * `blume-lang-icon`).
 */
export interface BlumeShikiOptions {
  /** Prepend a brand language icon to the header (`markdown.code.icons`). */
  icons?: boolean;
}

export const blumeShikiTransformers = (
  options: BlumeShikiOptions = {}
): ShikiTransformer[] => {
  const transformers: ShikiTransformer[] = [
    transformerNotationHighlight({ matchAlgorithm: "v3" }),
    transformerNotationDiff({ matchAlgorithm: "v3" }),
    transformerNotationWordHighlight({ matchAlgorithm: "v3" }),
    transformerNotationFocus({ matchAlgorithm: "v3" }),
    transformerMetaHighlight(),
  ];
  if (options.icons !== false) {
    transformers.push(languageIconTransformer() as unknown as ShikiTransformer);
  }
  // The fence-meta reader (title / line numbers) always runs last.
  transformers.push(codeTitleTransformer() as unknown as ShikiTransformer);
  return transformers;
};

/**
 * Sätteri Markdown features Blume enables beyond Astro's defaults. GFM,
 * frontmatter, and smart punctuation are already on; this adds superscript
 * (`^text^`) and subscript (`~text~`), which render to native `<sup>`/`<sub>`.
 */
const FEATURES = { subscript: true, superscript: true };

/** Options shared by both processors. */
export interface BlumeMarkdownOptions {
  /**
   * Wrap `<h2>`–`<h6>` in self-linking anchors (`markdown.headingAnchors`).
   * On unless explicitly `false`.
   */
  headingAnchors?: boolean;
  /** Highlight inline `` `code`{:lang} `` snippets (`markdown.code.inline`). */
  inline?: boolean;
}

/** Sätteri processor for plain `.md`, with Blume's curated feature set. */
export const blumeMarkdownProcessor = (options: BlumeMarkdownOptions = {}) =>
  satteri({
    features: { ...FEATURES },
    hastPlugins: blumeHastPlugins(options),
  });

export interface BlumeMdxOptions extends BlumeMarkdownOptions {
  /** Enable KaTeX math parsing and rendering. */
  math?: boolean;
}

/**
 * Sätteri MDX processor: Blume's feature set plus the MDAST plugins that target
 * components — `package-install` → package-manager tabs, `:::note` →
 * `<Callout>`, and ` ```mermaid ` → a `<blume-mermaid>` element. Used as the
 * `processor` for `@astrojs/mdx` so these apply to
 * `.mdx` only (plain `.md` uses {@link blumeMarkdownProcessor}). Math is opt-in
 * via config since `$` is common in prose and code.
 *
 * The plugins are modeled with minimal structural types; bridge them to
 * Satteri's full `MdastPlugin` type at this single boundary.
 */
export const blumeMdxProcessor = (options: BlumeMdxOptions = {}) => {
  const plugins: unknown[] = [
    packageInstallPlugin(),
    directiveToCalloutPlugin(),
    mintlifySvgIconPlugin(),
    mintlifyCodeGroupPlugin(),
    mermaidPlugin(),
  ];
  if (options.math) {
    plugins.push(mathPlugin());
  }
  return satteri({
    features: {
      ...FEATURES,
      directive: true,
      ...(options.math ? { math: true } : {}),
    },
    hastPlugins: blumeHastPlugins(options),
    mdastPlugins: plugins as unknown as MdastPlugin[],
  });
};

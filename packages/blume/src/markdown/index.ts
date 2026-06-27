import { satteri } from "@astrojs/markdown-satteri";

import { directiveToCalloutPlugin } from "./directives.ts";
import { mathPlugin } from "./math.ts";
import { mermaidPlugin } from "./mermaid.ts";
import { mintlifyCodeGroupPlugin } from "./mintlify-code-group.ts";
import { mintlifySvgIconPlugin } from "./mintlify-svg-icons.ts";
import { packageInstallPlugin } from "./package-install.ts";

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

/**
 * Sätteri Markdown features Blume enables beyond Astro's defaults. GFM,
 * frontmatter, and smart punctuation are already on; this adds superscript
 * (`^text^`) and subscript (`~text~`), which render to native `<sup>`/`<sub>`.
 */
const FEATURES = { subscript: true, superscript: true };

/** Sätteri processor for plain `.md`, with Blume's curated feature set. */
export const blumeMarkdownProcessor = () =>
  satteri({ features: { ...FEATURES } });

export interface BlumeMdxOptions {
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
    mdastPlugins: plugins as unknown as MdastPlugin[],
  });
};

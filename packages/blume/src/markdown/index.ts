import { satteri } from "@astrojs/markdown-satteri";
import {
  transformerMetaHighlight,
  transformerNotationDiff,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";
import { codeToHtml } from "shiki";

import { baseLinksPlugin } from "./base-links.ts";
import { codeTitleTransformer } from "./code-title.ts";
import { directiveToCalloutPlugin } from "./directives.ts";
import { headingAnchorPlugin } from "./heading-anchors.ts";
import { inlineCodeHighlightPlugin } from "./inline-code.ts";
import { languageIconTransformer } from "./language-icon.ts";
import { mathPlugin } from "./math.ts";
import { mermaidPlugin } from "./mermaid.ts";
import { packageInstallPlugin } from "./package-install.ts";
import { tableWrapPlugin } from "./table-wrap.ts";
import { DEFAULT_CODE_THEMES } from "./themes.ts";
import type { CodeThemes } from "./themes.ts";

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
 * always on: it only fires on an explicit trailing `{:lang}` marker, so plain
 * inline code is untouched and there's nothing to opt out of. Self-linking
 * heading anchors (`<h2>`–`<h6>` wrapped in an `<a>` to their own id) are on
 * unless `markdown.headingAnchors` is `false`. Inline code runs first so the
 * anchor wrap re-refs already-highlighted code.
 */
const blumeHastPlugins = (options: BlumeMarkdownOptions): HastPlugin[] => {
  const plugins: HastPlugin[] = [
    inlineCodeHighlightPlugin(options.codeThemes) as unknown as HastPlugin,
    tableWrapPlugin() as unknown as HastPlugin,
  ];
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

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/**
 * Tag the highlighted `<pre>` with `astro-code` (plus any extra classes) so the
 * theme's code-block styles apply — `codeToHtml`'s bare output is `pre.shiki`,
 * which the theme doesn't style.
 */
const astroCodeClassTransformer = (extra?: string): ShikiTransformer =>
  ({
    name: "blume:astro-code-class",
    pre(node: { properties: Record<string, unknown> }) {
      const existing =
        typeof node.properties.class === "string" ? node.properties.class : "";
      node.properties.class = `astro-code ${extra ?? ""} ${existing}`
        .replaceAll(/\s+/gu, " ")
        .trim();
    },
  }) as unknown as ShikiTransformer;

/**
 * Tag the `<pre>` with `data-language` — raw `codeToHtml` omits it (unlike
 * Astro's Markdown Shiki), and the theme's code header keys off it. Applied only
 * on the titled path so a titled standalone block renders the same header bar a
 * fence would, while header-less panes (e.g. the Component source view) stay
 * untouched.
 */
const languageAttrTransformer = (lang: string): ShikiTransformer =>
  ({
    name: "blume:data-language",
    pre(node: { properties: Record<string, unknown> }) {
      node.properties.dataLanguage ??= lang;
    },
  }) as unknown as ShikiTransformer;

export interface HighlightCodeOptions extends BlumeShikiOptions {
  /** Extra `<pre>` class names, e.g. `blume-source` for a height-capped pane. */
  className?: string;
  /**
   * Light/dark Shiki themes (`markdown.codeBlocks.theme`). Defaults to the same
   * github pair fenced code uses, so out-of-pipeline code stays in lockstep.
   */
  themes?: CodeThemes;
  /** Header title (a filename), matching a fence's `title="..."` meta. */
  title?: string;
}

/**
 * Highlight a code string with the same Shiki themes and transformers as Blume's
 * Markdown code fences, returning ready-to-render HTML. Use it to show themed
 * code *outside* the Markdown pipeline (custom pages, components): the output
 * carries the `astro-code` class and dual (light/dark) color variables, so the
 * theme styles it — including the light/dark swap — with no extra CSS. The
 * theme's code-block rules are scoped to `.prose`, so render the result inside a
 * `.prose` container (the shipped `<CodeBlock>` does this). An unknown language
 * falls back to an escaped plain block.
 */
export const highlightCode = async (
  code: string,
  lang: string,
  options: HighlightCodeOptions = {}
): Promise<string> => {
  try {
    return await codeToHtml(code, {
      defaultColor: false,
      lang,
      // The code-title transformer reads the fence meta; feeding a `title="..."`
      // string here gives non-fence callers (e.g. `<CodeBlock title>`) the same
      // `data-title` header a Markdown fence gets.
      meta: options.title
        ? { __raw: `title="${options.title.replaceAll('"', "")}"` }
        : undefined,
      themes: options.themes ?? DEFAULT_CODE_THEMES,
      transformers: [
        ...blumeShikiTransformers({ icons: options.icons }),
        astroCodeClassTransformer(options.className),
        ...(options.title ? [languageAttrTransformer(lang)] : []),
      ],
    });
  } catch {
    const className = `astro-code ${options.className ?? ""}`
      .replaceAll(/\s+/gu, " ")
      .trim();
    return `<pre class="${className}"><code>${escapeHtml(code)}</code></pre>`;
  }
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
   * Light/dark Shiki themes for inline `` `code`{:lang} `` highlighting
   * (`markdown.codeBlocks.theme`). Defaults to the github pair fenced code uses.
   */
  codeThemes?: CodeThemes;
  /**
   * Wrap `<h2>`–`<h6>` in self-linking anchors (`markdown.headingAnchors`).
   * On unless explicitly `false`.
   */
  headingAnchors?: boolean;
  /**
   * Site-wide route mount point (`""` or `/seg`). When set, root-relative
   * internal page links in content are rewritten under it, so authors write
   * links as if mounted at root.
   */
  basePath?: string;
  /**
   * Astro's `deployment.base` subdirectory (`""` or `/seg`), layered on top of
   * `basePath` when links are rewritten. Kept separate so a hand-written
   * `basePath` link isn't double-prefixed (see `withComposedBasePath`).
   */
  deployBase?: string;
}

/**
 * MDAST plugins that apply to both `.md` and `.mdx`. Currently just the
 * base-path link rewrite, added only when a `basePath` or `deployBase` is
 * configured.
 */
const blumeSharedMdastPlugins = (
  options: BlumeMarkdownOptions
): MdastPlugin[] =>
  options.basePath || options.deployBase
    ? [
        baseLinksPlugin(
          options.deployBase ?? "",
          options.basePath ?? ""
        ) as unknown as MdastPlugin,
      ]
    : [];

/** Sätteri processor for plain `.md`, with Blume's curated feature set. */
export const blumeMarkdownProcessor = (options: BlumeMarkdownOptions = {}) =>
  satteri({
    features: { ...FEATURES },
    hastPlugins: blumeHastPlugins(options),
    mdastPlugins: blumeSharedMdastPlugins(options),
  });

export type BlumeMdxOptions = BlumeMarkdownOptions;

/**
 * Sätteri MDX processor: Blume's feature set plus the MDAST plugins that target
 * components — `package-install` → package-manager tabs, `:::note` →
 * `<Callout>`, ` ```mermaid ` → a `<blume-mermaid>` element, and block math
 * (`$$…$$`) → the `<Math>` component. Used as the `processor` for
 * `@astrojs/mdx` so these apply to `.mdx` only (plain `.md` uses
 * {@link blumeMarkdownProcessor}).
 *
 * Math is always on but block-only: `singleDollarTextMath: false` keeps a bare
 * `$` (currency, shell, code) as literal text and only parses `$$…$$`. The
 * generated runtime imports the `<Math>` component (and KaTeX's stylesheet) only
 * when content actually uses `$$`, so a math-free site ships no KaTeX CSS.
 *
 * The plugins are modeled with minimal structural types; bridge them to
 * Satteri's full `MdastPlugin` type at this single boundary.
 */
export const blumeMdxProcessor = (options: BlumeMdxOptions = {}) =>
  satteri({
    features: {
      ...FEATURES,
      directive: true,
      // Block-only: `$$…$$` parses, a bare `$` stays literal text.
      math: { singleDollarTextMath: false },
    },
    hastPlugins: blumeHastPlugins(options),
    mdastPlugins: [
      packageInstallPlugin(),
      directiveToCalloutPlugin(),
      mermaidPlugin(),
      mathPlugin(),
      ...blumeSharedMdastPlugins(options),
    ] as unknown as MdastPlugin[],
  });

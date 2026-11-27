import { fileURLToPath } from "node:url";

import { satteri } from "@astrojs/markdown-satteri";
import {
  transformerMetaHighlight,
  transformerNotationDiff,
  transformerNotationErrorLevel,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";
import { escape as escapeHtml } from "html-escaper";
import { resolve } from "pathe";
import { codeToHtml } from "shiki";

import { withIncludedDefinitions } from "../core/includes.ts";
import { escapePinnedIds } from "../core/pinned-ids.ts";
import { hasVariables, substituteVariables } from "../core/variables.ts";
import type { ContentVariables } from "../core/variables.ts";
import { apiRailPlugin } from "./api-rail.ts";
import { baseLinksPlugin } from "./base-links.ts";
import { codeTitleTransformer } from "./code-title.ts";
import { contentAssetsPlugin } from "./content-assets.ts";
import { directiveToCalloutPlugin } from "./directives.ts";
import { externalLinksPlugin } from "./external-links.ts";
import { faqPlugin } from "./faq.ts";
import { MARKDOWN_BODY_FEATURES, MDX_BODY_FEATURES } from "./features.ts";
import { fenceLanguagePlugin } from "./fence-language.ts";
import { githubAlertsPlugin } from "./github-alerts.ts";
import { headingAnchorPlugin } from "./heading-anchors.ts";
import { includePlugin } from "./include.ts";
import { inlineCodeHighlightPlugin } from "./inline-code.ts";
import { languageIconTransformer } from "./language-icon.ts";
import { mathPlugin } from "./math.ts";
import { mermaidPlugin } from "./mermaid.ts";
import { packageInstallPlugin } from "./package-install.ts";
import { promptTextPlugin } from "./prompt-text.ts";
import { relativeLinksPlugin } from "./relative-links.ts";
import { svgFallbackPlugin } from "./svg-fallback.ts";
import { tableWrapPlugin } from "./table-wrap.ts";
import { DEFAULT_CODE_THEMES } from "./themes.ts";
import type { CodeThemes } from "./themes.ts";
import { titleHeadingPlugin } from "./title-heading.ts";
import { ts2jsPlugin } from "./ts2js.ts";
import { variablesPlugin } from "./variables.ts";
import { viewsPlugin } from "./views.ts";

export type { CodeTheme, CodeThemes } from "./themes.ts";

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
export { includePlugin } from "./include.ts";
export { mermaidPlugin } from "./mermaid.ts";
export { packageInstallPlugin } from "./package-install.ts";
export { ts2jsPlugin } from "./ts2js.ts";
export { blumeTwoslashTransformer } from "./twoslash.ts";

/** Element type of Satteri's `mdastPlugins`, sourced from the (alpha) core. */
type MdastPlugin = NonNullable<
  NonNullable<Parameters<typeof satteri>[0]>["mdastPlugins"]
>[number];

/** Element type of Satteri's `hastPlugins`. */
type HastPlugin = NonNullable<
  NonNullable<Parameters<typeof satteri>[0]>["hastPlugins"]
>[number];

/*
 * Blume's plugins model only the node/context slices they touch (no hast or
 * Satteri type dependency); these bridges are the single boundary where those
 * minimal structural shapes meet the host pipeline's full plugin types.
 */

// SAFETY: Satteri drives plugins through the same visitor protocol Blume's
// minimal structural shapes model; they narrow the node/context types the
// visitor hooks receive, never widen them.
const asHastPlugin = (plugin: { name: string }): HastPlugin =>
  plugin as HastPlugin;

// SAFETY: the same visitor-protocol bridge as `asHastPlugin`, for the mdast
// phase's plugins.
const asMdastPlugin = (plugin: { name: string }): MdastPlugin =>
  plugin as MdastPlugin;

// SAFETY: Shiki calls only the hooks a transformer declares, and Blume's
// transformers type their hook parameters as the hast slices they touch.
const asShikiTransformer = (transformer: { name: string }): ShikiTransformer =>
  transformer as ShikiTransformer;

/**
 * Hast plugins enabled by config. Inline `` `code`{:lang} `` highlighting is
 * always on: it only fires on an explicit trailing `{:lang}` marker, so plain
 * inline code is untouched and there's nothing to opt out of. The heading
 * plugin also always runs — it owns heading ids and the trailing markers
 * (`[#custom-id]`, `[!toc]`, `[toc]`), which must parse regardless of config —
 * while `markdown.headingAnchors: false` only turns off the self-linking
 * anchor wrap on `<h2>`–`<h6>`. Inline code runs first so the anchor wrap
 * re-refs already-highlighted code. The title-heading plugin runs after the
 * heading plugin has slugged every heading, so dropping an untitled page's
 * title `<h1>` moves no other heading's id. The external-link plugin is added
 * only when `markdown.externalLinks` is on, so off stays today's exact output.
 */
const blumeHastPlugins = (options: BlumeMarkdownOptions): HastPlugin[] => [
  asHastPlugin(inlineCodeHighlightPlugin(options.codeThemes)),
  asHastPlugin(tableWrapPlugin()),
  asHastPlugin(headingAnchorPlugin({ wrap: options.headingAnchors !== false })),
  asHastPlugin(titleHeadingPlugin()),
  ...(options.externalLinks ? [asHastPlugin(externalLinksPlugin())] : []),
];

/**
 * Shiki transformers enabled by default for every code block. The upstream
 * notation transformers read GitHub-style comments and strip them from the
 * output: `// [!code highlight]`, `// [!code ++]` / `// [!code --]`,
 * `// [!code word:x]`, `// [!code focus]`, and `// [!code error]` /
 * `// [!code warning]`. The v3 match algorithm scopes a
 * notation to the line it sits on (or the next, for a trailing comment).
 * `transformerMetaHighlight` adds numeric range highlighting from the fence meta
 * (` ```ts {1,3-5} `), reusing the same `highlighted` class. Blume's own
 * {@link languageIconTransformer} prepends a brand icon, and
 * {@link codeTitleTransformer} runs last to promote fence-meta (title / line
 * numbers) to `<pre>` attributes. The theme styles the classes these emit
 * (`highlighted`, `highlighted error/warning`, `diff add/remove`,
 * `highlighted-word`, `focused`, `blume-lang-icon`).
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
    // Only the two levels the theme styles: upstream also maps `[!code info]`,
    // which would otherwise strip the comment and leave a plain highlight.
    transformerNotationErrorLevel({
      classMap: {
        error: ["highlighted", "error"],
        warning: ["highlighted", "warning"],
      },
      matchAlgorithm: "v3",
    }),
    transformerMetaHighlight(),
  ];
  if (options.icons !== false) {
    transformers.push(asShikiTransformer(languageIconTransformer()));
  }
  // The fence-meta reader (title / line numbers) always runs last.
  transformers.push(asShikiTransformer(codeTitleTransformer()));
  return transformers;
};

/** The value space of a hast element property. */
type HastPropertyValue =
  | string
  | number
  | boolean
  | (string | number)[]
  | null
  | undefined;

/** The `<pre>` slice the class/language transformers touch. */
interface PreElement {
  properties: { class?: HastPropertyValue; dataLanguage?: HastPropertyValue };
}

const isStringProperty = (value: HastPropertyValue): value is string =>
  typeof value === "string";

/** A Blume-local Shiki transformer: a name plus the `pre` hook it declares. */
interface PreTransformer {
  name: string;
  pre: (node: PreElement) => void;
}

/**
 * Tag the highlighted `<pre>` with `astro-code` (plus any extra classes) so the
 * theme's code-block styles apply — `codeToHtml`'s bare output is `pre.shiki`,
 * which the theme doesn't style.
 */
const astroCodeClassTransformer = (extra?: string): ShikiTransformer => {
  const transformer: PreTransformer = {
    name: "blume:astro-code-class",
    pre(node) {
      const existing = isStringProperty(node.properties.class)
        ? node.properties.class
        : "";
      node.properties.class = `astro-code ${extra ?? ""} ${existing}`
        .replaceAll(/\s+/gu, " ")
        .trim();
    },
  };
  return asShikiTransformer(transformer);
};

/**
 * Tag the `<pre>` with `data-language` — raw `codeToHtml` omits it (unlike
 * Astro's Markdown Shiki), and the theme's code header keys off it. Applied only
 * on the titled path so a titled standalone block renders the same header bar a
 * fence would, while header-less panes (e.g. the Component source view) stay
 * untouched.
 */
const languageAttrTransformer = (lang: string): ShikiTransformer => {
  const transformer: PreTransformer = {
    name: "blume:data-language",
    pre(node) {
      node.properties.dataLanguage ??= lang;
    },
  };
  return asShikiTransformer(transformer);
};

export interface HighlightCodeOptions extends BlumeShikiOptions {
  /** Extra `<pre>` class names, e.g. `blume-source` for a height-capped pane. */
  className?: string;
  /**
   * Light/dark Shiki themes (`markdown.code.theme`). Defaults to the same
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

/** Options shared by both processors. */
export interface BlumeMarkdownOptions {
  /**
   * Light/dark Shiki themes for inline `` `code`{:lang} `` highlighting
   * (`markdown.code.theme`). Defaults to the github pair fenced code uses.
   */
  codeThemes?: CodeThemes;
  /**
   * Open external links in a new tab, marked with an arrow icon and a
   * screen-reader hint (`markdown.externalLinks`). Off unless `true`.
   */
  externalLinks?: boolean;
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
  /**
   * `variables`: `{{name}}` references replaced in `.md` pages and in every
   * included file (`.mdx` pages are substituted before parsing, by the
   * `variablesVitePlugin`).
   */
  variables?: ContentVariables;
  /**
   * The docs content root, bounding `<include>` target resolution (and
   * anchoring `/`-leading include paths). When unset, relative includes still
   * resolve from the including file. Also the base the `docs` collection's
   * entry ids are relative to, which relative page links resolve through.
   */
  contentRoot?: string;
  /**
   * The `blume:data` snapshot file an ejected app aliases. Relative page links
   * (and the base-path rewrite of dotted page routes) resolve through the
   * snapshot the CLI publishes; with no CLI in the process, they read this
   * file instead.
   */
  dataFile?: string;
}

/**
 * MDAST plugins that apply to both `.md` and `.mdx`: an SVG Astro can't
 * measure pointed at its served original, relative page links rewritten to
 * the served URL of the route they mean, references to other files beside the
 * page to their served copies, then the base-path link rewrite for
 * root-relative links (added only when a `basePath` or `deployBase` is
 * configured).
 */
const blumeSharedMdastPlugins = (
  options: BlumeMarkdownOptions
): MdastPlugin[] => [
  asMdastPlugin(svgFallbackPlugin()),
  asMdastPlugin(
    relativeLinksPlugin({
      contentRoot: options.contentRoot,
      dataFile: options.dataFile,
      deployBase: options.deployBase,
    })
  ),
  asMdastPlugin(
    contentAssetsPlugin({
      dataFile: options.dataFile,
      deployBase: options.deployBase,
    })
  ),
  ...(options.basePath || options.deployBase
    ? [
        asMdastPlugin(
          baseLinksPlugin(options.deployBase ?? "", options.basePath ?? "", {
            dataFile: options.dataFile,
          })
        ),
      ]
    : []),
];

/**
 * The `<include>` splice. Always first: its mutations apply before the next
 * plugin runs, so spliced content flows through the rest of the chain
 * (callouts, mermaid, math, base links) like inline content.
 */
const blumeIncludePlugin = (options: BlumeMarkdownOptions): MdastPlugin =>
  asMdastPlugin(
    includePlugin({
      contentRoot: options.contentRoot,
      variables: options.variables,
    })
  );

/** A Sätteri processor, as `satteri()` builds one. */
type SatteriProcessor = ReturnType<typeof satteri>;

/**
 * `processor`, rendering each page from the source its parse needs: with the
 * link-reference definitions its includes write appended (see
 * `withIncludedDefinitions`) — the include splice runs after the page is
 * parsed, too late for the parse to resolve a reference in the page against
 * a partial's definition — and with the punctuation in its pinned heading
 * ids escaped (see `escapePinnedIds`), so smart punctuation leaves a
 * `[#a--b]` pin as written. Pages with neither render their source as given.
 */
const withRenderSource = (
  processor: SatteriProcessor,
  options: BlumeMarkdownOptions
): SatteriProcessor => {
  const contentRoot = options.contentRoot
    ? resolve(options.contentRoot)
    : undefined;
  const source = async (content: string, sourcePath: string) =>
    substituteVariables(
      await withIncludedDefinitions(content, { contentRoot, sourcePath }),
      options.variables
    );
  const { createMdxRenderer, createRenderer } = processor;
  const wrapped: SatteriProcessor = {
    ...processor,
    createRenderer: async (shared) => {
      const renderer = await createRenderer(shared);
      return {
        render: async (content, renderOptions) =>
          renderer.render(
            escapePinnedIds(
              renderOptions?.fileURL
                ? await source(content, fileURLToPath(renderOptions.fileURL))
                : content,
              "markdown"
            ),
            renderOptions
          ),
      };
    },
  };
  if (createMdxRenderer) {
    wrapped.createMdxRenderer = async (shared, mdx) => {
      const renderer = await createMdxRenderer(shared, mdx);
      return {
        process: async (content, filePath, frontmatter) =>
          renderer.process(
            escapePinnedIds(await source(content, filePath), "mdx"),
            filePath,
            frontmatter
          ),
      };
    };
  }
  return wrapped;
};

/** Sätteri processor for plain `.md`, with Blume's curated feature set. */
export const blumeMarkdownProcessor = (options: BlumeMarkdownOptions = {}) =>
  withRenderSource(
    satteri({
      features: { ...MARKDOWN_BODY_FEATURES },
      hastPlugins: blumeHastPlugins(options),
      mdastPlugins: [
        blumeIncludePlugin(options),
        asMdastPlugin(fenceLanguagePlugin()),
        ...(hasVariables(options.variables)
          ? [asMdastPlugin(variablesPlugin(options.variables))]
          : []),
        ...blumeSharedMdastPlugins(options),
      ],
    }),
    options
  );

export type BlumeMdxOptions = BlumeMarkdownOptions;

/**
 * Sätteri MDX processor: Blume's feature set plus the MDAST plugins that target
 * components — `package-install` → package-manager tabs, ` ```ts ts2js ` →
 * TypeScript/JavaScript tabs, `:::note` and GitHub's `> [!NOTE]` alerts →
 * `<Callout>`, ` ```mermaid ` → a
 * `<blume-mermaid>` element, block math
 * (`$$…$$`) → the `<Math>` component, top-level `<RequestExample>` and
 * `<ResponseExample>` → the page's `<ApiRail>`, and a `<Prompt>` body's text
 * back to the punctuation its author typed. Used as the `processor` for
 * `@astrojs/mdx` so these apply to `.mdx` only (plain `.md` uses
 * {@link blumeMarkdownProcessor}).
 *
 * Math is always on and written `$$…$$`, as a block or inline:
 * `singleDollarTextMath: false` keeps a bare `$` (currency, shell, code) as
 * literal text. The
 * generated runtime imports the `<Math>` component (and KaTeX's stylesheet) only
 * when content actually uses `$$`, so a math-free site ships no KaTeX CSS.
 *
 * The plugins are modeled with minimal structural types; bridge them to
 * Satteri's full `MdastPlugin` type at this single boundary.
 */
export const blumeMdxProcessor = (options: BlumeMdxOptions = {}) =>
  withRenderSource(
    satteri({
      features: { ...MDX_BODY_FEATURES },
      hastPlugins: blumeHastPlugins(options),
      mdastPlugins: [
        blumeIncludePlugin(options),
        asMdastPlugin(fenceLanguagePlugin()),
        asMdastPlugin(packageInstallPlugin()),
        asMdastPlugin(ts2jsPlugin()),
        asMdastPlugin(directiveToCalloutPlugin()),
        asMdastPlugin(githubAlertsPlugin()),
        asMdastPlugin(mermaidPlugin()),
        asMdastPlugin(mathPlugin()),
        ...blumeSharedMdastPlugins(options),
        asMdastPlugin(apiRailPlugin()),
        asMdastPlugin(viewsPlugin()),
        asMdastPlugin(faqPlugin()),
        asMdastPlugin(promptTextPlugin()),
      ],
    }),
    options
  );

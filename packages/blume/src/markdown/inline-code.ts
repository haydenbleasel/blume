/**
 * Inline syntax highlighting for `` `code{:lang}` ``. A Satteri hast plugin runs
 * after Markdown is turned into hast and looks at each inline `<code>` for a
 * trailing `{:lang}` marker. The marker sits *inside* the backticks (Shiki's
 * "tailing-curly-colon" convention) so it survives MDX, where a `{…}` after a
 * code span would be parsed as a JSX expression. When found, it strips the
 * marker and replaces the code's text with Shiki tokens (dual github-light/dark
 * via CSS variables, like fenced blocks).
 *
 * Shiki is imported lazily, so it loads only on pages that actually use inline
 * highlighting — and never when `markdown.code.inline` is off (the plugin is not
 * added to the pipeline at all).
 */

import { DEFAULT_CODE_THEMES } from "./themes.ts";
import type { CodeThemes } from "./themes.ts";

/** A minimal hast node (avoids a hast type dependency). */
interface HastNode {
  children?: HastNode[];
  properties?: Record<string, unknown>;
  tagName?: string;
  type: string;
  value?: string;
}

/** The slice of Satteri's hast visitor context this plugin reads. */
interface HastContext {
  parent: (node: HastNode) => { tagName?: string } | undefined;
  textContent: (node: HastNode) => string;
}

/** A Satteri hast plugin, typed structurally to avoid a Satteri dep. */
export interface InlineCodePlugin {
  name: string;
  element: {
    filter: string[];
    visit: (node: HastNode, ctx: HastContext) => Promise<HastNode | undefined>;
  };
}

/** Parsed `{:lang}` marker and the code with it removed. */
export interface InlineLang {
  code: string;
  lang: string;
}

const INLINE_LANG = /\{:(?<lang>[\w+-]+)\}$/u;

/** Parse a trailing `{:lang}` marker from an inline `<code>`'s own text. */
export const parseInlineLang = (text: string): InlineLang | null => {
  const match = text.match(INLINE_LANG);
  if (!match?.groups?.lang || match.index === undefined) {
    return null;
  }
  const code = text.slice(0, match.index);
  return code ? { code, lang: match.groups.lang } : null;
};

/** Loosely-typed Shiki entry: just the inline-highlight call this plugin makes. */
type InlineHighlighter = (
  code: string,
  options: {
    defaultColor: false;
    lang: string;
    structure: "inline";
    themes: CodeThemes;
  }
) => Promise<{ children: HastNode[] }>;

// `import()` caches the module, so this dedupes Shiki across calls on its own.
const loadHighlighter = async (): Promise<InlineHighlighter> => {
  const mod = await import("shiki");
  return mod.codeToHast as unknown as InlineHighlighter;
};

/** Build the plugin. Highlights inline `` `code{:lang}` `` snippets. */
export const inlineCodeHighlightPlugin = (
  themes: CodeThemes = DEFAULT_CODE_THEMES
): InlineCodePlugin => ({
  element: {
    filter: ["code"],
    async visit(node, ctx) {
      // Only inline code: a <code> inside <pre> is a fenced block — skip it.
      if (ctx.parent(node)?.tagName === "pre") {
        return;
      }
      const parsed = parseInlineLang(ctx.textContent(node));
      if (!parsed) {
        return;
      }
      try {
        const codeToHast = await loadHighlighter();
        const root = await codeToHast(parsed.code, {
          defaultColor: false,
          lang: parsed.lang,
          structure: "inline",
          themes,
        });
        return {
          children: root.children,
          properties: { className: ["blume-inline-code"] },
          tagName: "code",
          type: "element",
        };
      } catch {
        // Unknown language or load failure: still strip the marker — the
        // literal `{:lang}` must not ship in the page — and fall back to
        // plain, unhighlighted inline code.
        return {
          ...node,
          children: [{ type: "text", value: parsed.code }],
        };
      }
    },
  },
  name: "blume:inline-code",
});

/**
 * Minimal structural types and node builders for the (alpha) Satteri MDAST
 * plugin API. We model only what Blume's plugins read and construct; the full
 * types live in `satteri`, a transitive dependency. Plugins are bridged to
 * Satteri's real `MdastPlugin` type at a single boundary in `index.ts`.
 */

/** The visitor context Blume's plugins use to mutate the tree. */
export interface MdastVisitorContext {
  replaceNode: (node: unknown, replacement: unknown) => void;
}

/** Any MDAST node, keyed loosely since we build a small subset by hand. */
export interface MdastNode {
  type: string;
  [key: string]: unknown;
}

/** Build an MDX JSX attribute. A `null` value renders as a boolean attribute. */
export const jsxAttribute = (name: string, value: string | null = null) => ({
  name,
  type: "mdxJsxAttribute",
  value,
});

type JsxAttribute = ReturnType<typeof jsxAttribute>;

/** Build a block-level MDX JSX element (`<Name>…</Name>`). */
export const jsxFlowElement = (
  name: string,
  attributes: JsxAttribute[],
  children: unknown[]
) => ({ attributes, children, name, type: "mdxJsxFlowElement" });

/** Build an inline MDX JSX element (phrasing context). */
export const jsxTextElement = (
  name: string,
  attributes: JsxAttribute[],
  children: unknown[] = []
) => ({ attributes, children, name, type: "mdxJsxTextElement" });

/** Build a fenced code block node. */
export const codeBlock = (lang: string, value: string) => ({
  lang,
  meta: null,
  type: "code",
  value,
});

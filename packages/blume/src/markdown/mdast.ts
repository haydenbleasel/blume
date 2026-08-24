/**
 * Minimal structural types and node builders for the (alpha) Satteri MDAST
 * plugin API. We model only what Blume's plugins read and construct; the full
 * types live in `satteri`, a transitive dependency. Plugins are bridged to
 * Satteri's real `MdastPlugin` type at a single boundary in `index.ts`.
 */

/**
 * A property value on an MDAST node: primitives, nested nodes, and lists of
 * either. Covers everything Blume's plugins read or build (positions, data
 * flags, attribute lists) without admitting functions or class instances.
 */
export type MdastValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | MdastValue[]
  | { [key: string]: MdastValue };

/** The visitor context Blume's plugins use to mutate the tree. */
export interface MdastVisitorContext {
  replaceNode: (node: MdastNode, replacement: MdastNode) => void;
}

/** Any MDAST node, keyed loosely since we build a small subset by hand. */
export interface MdastNode {
  type: string;
  [key: string]: MdastValue;
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
  children: MdastValue[]
) => ({ attributes, children, name, type: "mdxJsxFlowElement" });

/** Build an inline MDX JSX element (phrasing context). */
export const jsxTextElement = (
  name: string,
  attributes: JsxAttribute[],
  children: MdastValue[] = []
) => ({ attributes, children, name, type: "mdxJsxTextElement" });

/** Build a fenced code block node, optionally with a fence-meta string. */
export const codeBlock = (
  lang: string,
  value: string,
  meta: string | null = null
) => ({
  lang,
  meta,
  type: "code",
  value,
});

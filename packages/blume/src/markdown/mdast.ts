/**
 * Minimal structural types and node builders for the (alpha) Satteri MDAST
 * plugin API. We model only what Blume's plugins read and construct; the full
 * types live in `satteri`, a transitive dependency. Plugins are bridged to
 * Satteri's real `MdastPlugin` type at a single boundary in `index.ts`.
 */

export interface MdastVisitorContext {
  replaceNode: (node: unknown, replacement: unknown) => void;
  source?: string;
}

export interface MdastNode {
  type: string;
  [key: string]: unknown;
}

export const jsxAttribute = (name: string, value: string | null = null) => ({
  name,
  type: "mdxJsxAttribute",
  value,
});

export const jsxFlowElement = (
  name: string,
  attributes: unknown[],
  children: unknown[]
) => ({ attributes, children, name, type: "mdxJsxFlowElement" });

export const jsxTextElement = (
  name: string,
  attributes: unknown[],
  children: unknown[] = []
) => ({ attributes, children, name, type: "mdxJsxTextElement" });

export const codeBlock = (lang: string, value: string) => ({
  lang,
  meta: null,
  type: "code",
  value,
});

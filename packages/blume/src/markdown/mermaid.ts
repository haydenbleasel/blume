import { jsxAttribute, jsxFlowElement } from "./mdast.ts";
import type { MdastNode, MdastVisitorContext } from "./mdast.ts";

interface CodeNode extends MdastNode {
  lang?: string | null;
  meta?: string | null;
  value: string;
}

const ATTRIBUTE_PATTERN =
  /(?<name>[A-Za-z_$][\w$-]*)=(?:"(?<double>[^"]*)"|'(?<single>[^']*)'|\{(?<expression>[^}]*)\}|(?<bare>[^\s]+))/gu;

const metaAttributes = (meta: string | null | undefined): unknown[] => {
  if (!meta) {
    return [];
  }

  const attributes: unknown[] = [];
  for (const match of meta.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match.groups?.name;
    if (name !== "actions" && name !== "placement") {
      continue;
    }

    const value =
      match.groups?.double ??
      match.groups?.single ??
      match.groups?.expression ??
      match.groups?.bare;
    if (name && value !== undefined) {
      attributes.push(jsxAttribute(name, value));
    }
  }
  return attributes;
};

/**
 * Mintlify renders fenced `mermaid` code blocks as diagrams with optional
 * `actions` and `placement` fence props. Rewrite them to Blume's Mermaid
 * component before syntax highlighting can treat them as ordinary code.
 */
export const mermaidPlugin = () => ({
  code(node: CodeNode, ctx: MdastVisitorContext) {
    if (node.lang !== "mermaid") {
      return;
    }

    ctx.replaceNode(
      node,
      jsxFlowElement(
        "Mermaid",
        [jsxAttribute("code", node.value), ...metaAttributes(node.meta)],
        []
      )
    );
  },
  name: "blume-mermaid",
});

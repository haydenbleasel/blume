import { jsxAttribute, jsxFlowElement } from "./mdast.ts";
import type { MdastNode, MdastVisitorContext } from "./mdast.ts";

interface MdxJsxFlowElementNode extends MdastNode {
  attributes?: unknown[];
  children?: MdastNode[];
  name?: string | null;
}

interface CodeNode extends MdastNode {
  lang?: string | null;
  meta?: string | null;
  value: string;
}

const isCodeNode = (node: MdastNode): node is CodeNode =>
  node.type === "code" && typeof node.value === "string";

const titleFromCodeFence = (node: CodeNode): string => {
  const meta = node.meta?.trim();
  if (!meta) {
    return node.lang ?? "Code";
  }

  const titleMatch = meta.match(
    /(?:^|\s)title=(?:"(?<double>[^"]+)"|'(?<single>[^']+)'|(?<bare>[^\s]+))/u
  );
  return (
    titleMatch?.groups?.double ??
    titleMatch?.groups?.single ??
    titleMatch?.groups?.bare ??
    meta
  );
};

const cloneCodeNode = (node: CodeNode): CodeNode => ({
  lang: node.lang ?? null,
  meta: node.meta ?? null,
  type: "code",
  value: node.value,
});

const wrapCodeChildren = (node: MdxJsxFlowElementNode) => {
  const children = (node.children ?? []).map((child) => {
    if (!isCodeNode(child)) {
      return child;
    }

    return jsxFlowElement(
      "Tab",
      [jsxAttribute("title", titleFromCodeFence(child))],
      [cloneCodeNode(child)]
    );
  });

  return jsxFlowElement(node.name ?? "", node.attributes ?? [], children);
};

/**
 * Mintlify accepts raw titled fenced code blocks inside tab-like components.
 * Astro/MDX otherwise compiles those as stacked `<pre>` elements, so Blume
 * rewrites direct code children to `<Tab title="...">` panels before syntax
 * highlighting runs.
 */
export const mintlifyCodeGroupPlugin = () => ({
  mdxJsxFlowElement(node: MdxJsxFlowElementNode, ctx: MdastVisitorContext) {
    if (
      !["CodeGroup", "RequestExample", "ResponseExample"].includes(
        node.name ?? ""
      ) ||
      !node.children?.some(isCodeNode)
    ) {
      return;
    }

    ctx.replaceNode(node, wrapCodeChildren(node));
  },
  name: "blume-mintlify-code-group",
});

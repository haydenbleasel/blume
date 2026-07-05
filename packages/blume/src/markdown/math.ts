import { jsxAttribute, jsxFlowElement, jsxTextElement } from "./mdast.ts";
import type { MdastNode, MdastVisitorContext } from "./mdast.ts";

interface MathNode extends MdastNode {
  value: string;
}

/**
 * Satteri MDAST plugin that turns math nodes into Blume's `<Math>` component,
 * which renders them with KaTeX at build time. Block math (`$$…$$`) becomes a
 * block element. Blume runs the parser block-only (`singleDollarTextMath:
 * false`), so a bare `$` stays literal and no `inlineMath` nodes are produced;
 * the `inlineMath` visitor remains as a harmless safety net.
 */
export const mathPlugin = () => ({
  inlineMath(node: MathNode, ctx: MdastVisitorContext) {
    ctx.replaceNode(
      node,
      jsxTextElement("Math", [jsxAttribute("code", node.value)])
    );
  },
  math(node: MathNode, ctx: MdastVisitorContext) {
    ctx.replaceNode(
      node,
      jsxFlowElement(
        "Math",
        [jsxAttribute("code", node.value), jsxAttribute("display")],
        []
      )
    );
  },
  name: "blume-math",
});

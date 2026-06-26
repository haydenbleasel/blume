import { jsxAttribute, jsxFlowElement } from "./mdast.ts";
import type { MdastNode, MdastVisitorContext } from "./mdast.ts";

interface CodeNode extends MdastNode {
  lang?: string | null;
  value: string;
}

/**
 * Satteri MDAST plugin that turns a ` ```mermaid ` code block into a
 * `<blume-mermaid>` custom element carrying the raw diagram source. There is no
 * importable component — the fence is the whole interface. The element is
 * rendered on the client (Mermaid needs a DOM), so the source rides on a string
 * attribute rather than as child text (which MDX would try to parse).
 */
export const mermaidPlugin = () => ({
  code(node: CodeNode, ctx: MdastVisitorContext) {
    if (node.lang !== "mermaid") {
      return;
    }
    ctx.replaceNode(
      node,
      jsxFlowElement(
        "blume-mermaid",
        [
          jsxAttribute(
            "class",
            "not-prose my-6 flex justify-center overflow-x-auto"
          ),
          jsxAttribute("data-source", node.value),
        ],
        []
      )
    );
  },
  name: "blume-mermaid",
});

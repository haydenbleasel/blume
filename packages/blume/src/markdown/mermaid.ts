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
 * rendered on the client (Pele needs a DOM), so the source rides on a string
 * attribute rather than as child text (which MDX would try to parse).
 */
/**
 * A ```mermaid (or ~~~mermaid) fence opener at the start of a line. Used to
 * decide, at generation time, whether the site needs the diagram renderer at
 * all — see `featuresTemplate`.
 */
const MERMAID_FENCE = /^[ \t]*(?:`{3,}|~{3,})[ \t]*mermaid\b/mu;

/** Whether a page's Markdown/MDX source contains a mermaid fence. */
export const hasMermaidFence = (text: string): boolean =>
  MERMAID_FENCE.test(text);

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
            // Pele's SVG carries width/height attributes but shrinks through
            // max-width:100%, so the wrapper must fill the column (w-full) for
            // that percentage to mean the column; the SVG centers itself with
            // auto margins. overflow-x-auto keeps a diagram that can't reflow
            // scrollable instead of clipped.
            "not-prose my-6 flex overflow-x-auto [&>div]:w-full [&>div>svg]:mx-auto [&>div>svg]:block"
          ),
          jsxAttribute("data-source", node.value),
        ],
        []
      )
    );
  },
  name: "blume-mermaid",
});

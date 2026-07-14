/** Wraps each `<table>` in a scroll container. Satteri does not re-descend into a visitor's returned replacement, so the wrapped table is not re-visited. */

/** A minimal hast node (avoids a hast type dependency). */
interface HastNode {
  children?: HastNode[];
  properties?: Record<string, unknown>;
  tagName?: string;
  type: string;
  value?: string;
}

/** A Satteri hast plugin, typed structurally to avoid a Satteri dep. */
export interface TableWrapPlugin {
  name: string;
  element: {
    filter: string[];
    visit: (node: HastNode) => HastNode;
  };
}

export const tableWrapPlugin = (): TableWrapPlugin => ({
  element: {
    filter: ["table"],
    visit(node) {
      return {
        children: [node],
        properties: { className: ["blume-table-scroll"] },
        tagName: "div",
        type: "element",
      };
    },
  },
  name: "blume:table-wrap",
});

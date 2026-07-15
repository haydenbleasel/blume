/**
 * Wraps each `<table>` in a scroll container. Satteri does not re-descend into a
 * visitor's returned replacement, so the wrapped table is not re-visited.
 *
 * The wrapper carries `tabindex="0"` so a horizontally scrolling table is
 * reachable and scrollable by keyboard, not just pointer (WCAG 2.1.1; axe's
 * `scrollable-region-focusable`). It's added unconditionally — whether a given
 * table overflows isn't known at build time — which costs a tab stop on tables
 * that happen to fit; no ARIA label is set to avoid an untranslated string.
 */

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
        properties: { className: ["blume-table-scroll"], tabIndex: 0 },
        tagName: "div",
        type: "element",
      };
    },
  },
  name: "blume:table-wrap",
});

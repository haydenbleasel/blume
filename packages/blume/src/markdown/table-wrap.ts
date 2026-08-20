/**
 * Wraps each `<table>` in a scroll container. Satteri does not re-descend into a
 * visitor's returned replacement, so the wrapped table is not re-visited.
 *
 * The wrapper carries `tabindex="0"` so a horizontally scrolling table is
 * reachable and scrollable by keyboard, not just pointer (WCAG 2.1.1; axe's
 * `scrollable-region-focusable`). It's added unconditionally — whether a given
 * table overflows isn't known at build time — which costs a tab stop on tables
 * that happen to fit; no ARIA label is set to avoid an untranslated string.
 *
 * GFM has no headerless-table syntax — the delimiter row is mandatory, so a
 * table that doesn't want headers is authored with an empty first row
 * (`| | |`). That parses to a `<thead>` of blank cells, which renders as a
 * dead band above the body; such a header row is dropped here. A header cell
 * containing any non-text content (an image, an icon) counts as non-empty.
 */

/** The value shapes hast allows on an element's `properties`. */
type HastPropertyValue = string | number | boolean | (string | number)[];

/** A minimal hast node (avoids a hast type dependency). */
interface HastNode {
  children?: HastNode[];
  properties?: Record<string, HastPropertyValue>;
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

/** Structural elements whose presence alone doesn't make a header non-empty. */
const HEADER_STRUCTURE = new Set(["thead", "tr", "th"]);

/** Whether a header subtree contains anything that would render visibly. */
const hasVisibleContent = (node: HastNode): boolean => {
  if (node.type === "text") {
    return (node.value ?? "").trim() !== "";
  }
  if (node.tagName && !HEADER_STRUCTURE.has(node.tagName)) {
    return true;
  }
  return (node.children ?? []).some(hasVisibleContent);
};

const isEmptyThead = (node: HastNode): boolean =>
  node.tagName === "thead" && !hasVisibleContent(node);

export const tableWrapPlugin = (): TableWrapPlugin => ({
  element: {
    filter: ["table"],
    visit(node) {
      // Satteri serializes an unchanged node by identity, so stripping the
      // header must produce a new table object — mutating `node.children`
      // in place has no effect on the output.
      const table = node.children?.some(isEmptyThead)
        ? {
            ...node,
            children: node.children.filter((child) => !isEmptyThead(child)),
          }
        : node;
      return {
        children: [table],
        properties: { className: ["blume-table-scroll"], tabIndex: 0 },
        tagName: "div",
        type: "element",
      };
    },
  },
  name: "blume:table-wrap",
});

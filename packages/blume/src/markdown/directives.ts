import { toString as mdastToString } from "mdast-util-to-string";

import { jsxAttribute, jsxFlowElement } from "./mdast.ts";
import type { MdastNode, MdastVisitorContext } from "./mdast.ts";

interface DirectiveNode extends MdastNode {
  attributes?: Record<string, string | null | undefined> | null;
  // Satteri gives an empty container directive (`:::note\n:::`) `children: null`.
  children?: MdastNode[] | null;
  name: string;
}

/** Directive names that map directly onto a Callout type. */
const CALLOUT_TYPES = new Set([
  "danger",
  "info",
  "note",
  "success",
  "tip",
  "warning",
]);

/** Friendly aliases for the canonical Callout types. */
interface CalloutAliases {
  [alias: string]: string;
}

const ALIASES: CalloutAliases = {
  caution: "warning",
  error: "danger",
  important: "note",
  warn: "warning",
};

/** Resolve a directive name to a Callout type, or `null` if it is not one. */
export const calloutTypeFor = (name: string): string | null => {
  const lower = name.toLowerCase();
  if (CALLOUT_TYPES.has(lower)) {
    return lower;
  }
  return ALIASES[lower] ?? null;
};

/**
 * Satteri MDAST plugin mapping container directives (`:::note`, `:::warning`,
 * `:::tip`, …) onto Blume's `<Callout>` component. The title comes from a
 * `[label]` or a `{title="…"}` attribute; the body becomes the callout content.
 * Directive names that are not callouts are left untouched.
 */
export const directiveToCalloutPlugin = () => ({
  containerDirective(node: DirectiveNode, ctx: MdastVisitorContext) {
    const type = calloutTypeFor(node.name);
    if (type === null) {
      return;
    }

    const children = [...(node.children ?? [])];
    let title = node.attributes?.title ?? undefined;

    // A leading `:::name[Label]` parses to a paragraph flagged `directiveLabel`.
    // SAFETY: Satteri stamps `directiveLabel` on that paragraph's `data`; any
    // other node reads undefined and fails the check.
    const labelIndex = children.findIndex(
      (child) =>
        child.type === "paragraph" &&
        (child.data as { directiveLabel?: boolean } | undefined)?.directiveLabel
    );
    if (labelIndex !== -1) {
      const [label] = children.splice(labelIndex, 1);
      if (label) {
        // Flatten the label's phrasing children so `:::note[Read **this**]`
        // yields `Read this`; image alt is excluded (an image is not label
        // text), matching the historical child-values-only behavior.
        title ??= mdastToString(label, { includeImageAlt: false }) || undefined;
      }
    }

    const attributes = [jsxAttribute("type", type)];
    if (title) {
      attributes.push(jsxAttribute("title", title));
    }
    ctx.replaceNode(node, jsxFlowElement("Callout", attributes, children));
  },
  name: "blume-directive-callout",
});

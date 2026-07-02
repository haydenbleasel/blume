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
const ALIASES: Record<string, string> = {
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

interface TextNode extends MdastNode {
  value?: string;
}

/**
 * Concatenate the plain text of a node, recursing through phrasing children so
 * formatted labels keep every word — `:::note[Read **this**]` yields
 * `Read this`, not `Read ` (the bolded run dropped).
 */
const textOf = (node: MdastNode): string => {
  const { children } = node as { children?: MdastNode[] };
  if (children && children.length > 0) {
    return children.map(textOf).join("");
  }
  return (node as TextNode).value ?? "";
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
    const labelIndex = children.findIndex(
      (child) =>
        child.type === "paragraph" &&
        (child.data as { directiveLabel?: boolean } | undefined)?.directiveLabel
    );
    if (labelIndex !== -1) {
      const [label] = children.splice(labelIndex, 1);
      if (label) {
        title ??= textOf(label) || undefined;
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

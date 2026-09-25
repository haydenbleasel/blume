import { toString as mdastToString } from "mdast-util-to-string";

import { jsxAttribute, jsxFlowElement } from "./mdast.ts";
import type { MdastNode, MdastVisitorContext } from "./mdast.ts";

export interface DirectiveNode extends MdastNode {
  attributes?: Record<string, string | null | undefined> | null;
  // Satteri gives an empty container directive (`:::note\n:::`) `children: null`.
  children?: MdastNode[] | null;
  name: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

/**
 * The visitor-context slice the directive visitors use. `source` is the page
 * the directive offsets index into; without it the literal fallback rebuilds
 * a directive from its node instead. `parent` walks up to an enclosing
 * container directive, which renders the directives inside it itself.
 */
interface DirectiveVisitorContext extends MdastVisitorContext {
  parent?: (node: MdastNode) => MdastNode | undefined;
  source?: string;
}

/** Directive names that map directly onto a Callout type. */
export const CALLOUT_TYPES: ReadonlySet<string> = new Set([
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

export const CALLOUT_ALIASES: Readonly<CalloutAliases> = {
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
  return CALLOUT_ALIASES[lower] ?? null;
};

/** The markers that open a text (`:name`) and a leaf (`::name`) directive. */
const LITERAL_MARKERS = new Map([
  ["leafDirective", "::"],
  ["textDirective", ":"],
]);

/** A directive's `[label]` rebuilt from its label's text, or nothing. */
const labelSource = (label: MdastNode[]): string =>
  label.length > 0
    ? `[${mdastToString(label, { includeImageAlt: false })}]`
    : "";

/** A directive's `{attributes}` rebuilt from its node, or nothing. */
const attributeSource = (node: DirectiveNode): string => {
  const attributes = Object.entries(node.attributes ?? {}).map(
    ([key, value]) => (value ? `${key}="${value}"` : key)
  );
  return attributes.length > 0 ? `{${attributes.join(" ")}}` : "";
};

/** The source a directive node spans, when its offsets point into `source`. */
const spannedSource = (node: DirectiveNode, source: string): string | null => {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return start !== undefined && end !== undefined
    ? source.slice(start, end)
    : null;
};

/**
 * A text or leaf directive exactly as the author wrote it. The slice by
 * offsets is the exact text — `[label]` and `{attrs}` included — and is
 * trusted only when it opens with the directive's own marker and name;
 * content an `<include>` spliced in carries no offsets into this page, so it
 * is rebuilt from the node instead.
 */
export const directiveSource = (
  node: DirectiveNode,
  marker: string,
  source: string
): string => {
  const opening = `${marker}${node.name}`;
  const slice = spannedSource(node, source);
  if (slice?.startsWith(opening)) {
    return slice;
  }
  return `${opening}${labelSource(node.children ?? [])}${attributeSource(node)}`;
};

/**
 * The node a text or leaf directive renders as: its literal source, as text
 * in place of a text directive and as a paragraph in place of a leaf one.
 */
const literalDirective = (
  node: DirectiveNode,
  marker: string,
  source: string
): MdastNode => {
  const text = { type: "text", value: directiveSource(node, marker, source) };
  return marker === ":" ? text : { children: [text], type: "paragraph" };
};

const FENCE = /^:{3,}/u;

// The line that closes a container: a colon fence, after whatever quote or
// list indentation the container sits in.
const CLOSING_FENCE = /\n[\t >]*(?<fence>:{3,})\s*$/u;

/** A paragraph holding one line of literal text. */
const literalLine = (value: string): MdastNode => ({
  children: [{ type: "text", value }],
  type: "paragraph",
});

/**
 * The fence lines of a container directive as the author wrote them — the
 * opening one with its `[label]` and `{attrs}` — or, without offsets into
 * this page (an `<include>`), rebuilt from the node. A container left
 * unclosed runs to the end of its parent and has no closing line.
 */
const containerFences = (
  node: DirectiveNode,
  label: MdastNode | undefined,
  source: string
): string[] => {
  const slice = spannedSource(node, source) ?? "";
  const fence = FENCE.exec(slice)?.[0];
  if (fence === undefined || !slice.startsWith(node.name, fence.length)) {
    const labelText = labelSource(label ? [label] : []);
    return [`:::${node.name}${labelText}${attributeSource(node)}`, ":::"];
  }
  const [opening = ""] = slice.split("\n", 1);
  const closing = CLOSING_FENCE.exec(slice.slice(opening.length))?.groups
    ?.fence;
  // A shorter fence can't close the container; it is the body's last line.
  return closing !== undefined && closing.length >= fence.length
    ? [opening.trimEnd(), closing]
    : [opening.trimEnd()];
};

/**
 * What a container directive renders as. A callout name becomes a
 * `<Callout>`: the title comes from a `[label]` or a `{title="…"}` attribute,
 * and the body becomes the callout content. Blume has no other container, and
 * dropping one would drop its body with it, so any other name — `:::details`,
 * a `:::warnig` typo — renders its body between its fence lines, as written.
 * The directives inside render here too, since Satteri reaches them only
 * after this replacement has taken their original.
 */
const renderContainer = (
  node: DirectiveNode,
  source: string
): MdastNode | MdastNode[] => {
  const children = (node.children ?? []).flatMap((child) =>
    // oxlint-disable-next-line no-use-before-define -- mutual recursion: a container's body holds directives, containers included
    literalize(child, source)
  );

  // A leading `:::name[Label]` parses to a paragraph flagged `directiveLabel`.
  // SAFETY: Satteri stamps `directiveLabel` on that paragraph's `data`; any
  // other node reads undefined and fails the check.
  const labelIndex = children.findIndex(
    (child) =>
      child.type === "paragraph" &&
      (child.data as { directiveLabel?: boolean } | undefined)?.directiveLabel
  );
  const [label] = labelIndex === -1 ? [] : children.splice(labelIndex, 1);

  const type = calloutTypeFor(node.name);
  if (type === null) {
    const [opening = "", closing] = containerFences(node, label, source);
    return [
      literalLine(opening),
      ...children,
      ...(closing === undefined ? [] : [literalLine(closing)]),
    ];
  }

  // Flatten the label's phrasing children so `:::note[Read **this**]` yields
  // `Read this`; image alt is excluded (an image is not label text), matching
  // the historical child-values-only behavior.
  const title =
    node.attributes?.title ??
    (label ? mdastToString(label, { includeImageAlt: false }) : undefined);
  const attributes = [jsxAttribute("type", type)];
  if (title) {
    attributes.push(jsxAttribute("title", title));
  }
  return jsxFlowElement("Callout", attributes, children);
};

/**
 * `node` with every directive in it rendered: text and leaf directives as
 * their literal source, containers as {@link renderContainer}.
 */
const literalize = (node: MdastNode, source: string): MdastNode[] => {
  if (node.type === "containerDirective") {
    // SAFETY: a `containerDirective` carries a `name` plus optional
    // attributes, children, and position — the `DirectiveNode` shape.
    return [renderContainer(node as DirectiveNode, source)].flat();
  }
  const marker = LITERAL_MARKERS.get(node.type);
  if (marker) {
    // SAFETY: only Satteri's `textDirective`/`leafDirective` nodes have a
    // marker, and they carry a `name` plus optional attributes, children,
    // and position — the `DirectiveNode` shape.
    return [literalDirective(node as DirectiveNode, marker, source)];
  }
  // SAFETY: a parent's `children` is always a node list; leaves carry none.
  const children = node.children as MdastNode[] | null | undefined;
  if (!children) {
    return [node];
  }
  return [
    {
      ...node,
      children: children.flatMap((child) => literalize(child, source)),
    },
  ];
};

/** Whether a container directive (already rendered, body and all) holds `node`. */
const insideContainer = (node: MdastNode, ctx: DirectiveVisitorContext) => {
  for (
    let parent = ctx.parent?.(node);
    parent !== undefined;
    parent = ctx.parent?.(parent)
  ) {
    if (parent.type === "containerDirective") {
      return true;
    }
  }
  return false;
};

/** The text and leaf visitor: render the directive as its literal source. */
const renderLiteral =
  (marker: string) => (node: DirectiveNode, ctx: DirectiveVisitorContext) => {
    // A container's body was already rendered into its replacement; a
    // transform queued on the replaced original would be dropped with a
    // warning.
    if (insideContainer(node, ctx)) {
      return;
    }
    ctx.replaceNode(node, literalDirective(node, marker, ctx.source ?? ""));
  };

/**
 * Satteri MDAST plugin for directives. Container directives (`:::note`,
 * `:::warning`, `:::tip`, …) map onto Blume's `<Callout>` component, and any
 * other container renders its body between its literal fence lines (see
 * {@link renderContainer}).
 *
 * Blume handles no text (`:name`) or leaf (`::name`) directives, and prose is
 * full of text that parses as one — `16:9`, `10:30am`, `og:image`,
 * `pets:read` — so both render as the literal source the author wrote instead
 * of vanishing.
 */
export const directiveToCalloutPlugin = () => ({
  containerDirective(node: DirectiveNode, ctx: DirectiveVisitorContext) {
    // A container inside another was rendered with its enclosing one.
    if (insideContainer(node, ctx)) {
      return;
    }
    ctx.replaceNode(node, renderContainer(node, ctx.source ?? ""));
  },
  leafDirective: renderLiteral("::"),
  name: "blume-directive-callout",
  // Positions are opt-in since satteri 0.10; the literal fallback slices
  // directives out of the source by offset.
  options: { position: true },
  textDirective: renderLiteral(":"),
});

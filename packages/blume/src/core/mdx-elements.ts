import type { Nodes } from "mdast";
import { mdxToMdast } from "satteri";

import { MDX_BODY_FEATURES } from "../markdown/features.ts";
import { BUILTIN_CHILD_PROPS } from "./builtin-tags.ts";
import type { ElementUse } from "./types.ts";

/**
 * JSX elements in an `.mdx` body whose props don't render as written:
 *
 * - `handler`: an HTML element with a JavaScript event handler
 *   (`<button onClick={() => …}>`). The page is static HTML, so the function
 *   is written into the attribute as text and never runs. A string handler
 *   (`onclick="…"`) is inline script the browser does run, and is left alone.
 * - `prop`: a built-in that shows its children (see `BUILTIN_CHILD_PROPS`),
 *   used without any, with props it doesn't take. Those are ignored, so the
 *   element renders without the content they carry.
 *
 * {@link parseMdxBody} parses a body once for this walk and for
 * `component-anchors.ts`.
 */

/** A JSX element in an `.mdx` body's tree, flow or inline. */
export type JsxElement = Extract<
  Nodes,
  { type: "mdxJsxFlowElement" | "mdxJsxTextElement" }
>;
type AttributeValue = Extract<
  JsxElement["attributes"][number],
  { type: "mdxJsxAttribute" }
>["value"];
type ExpressionValue = Extract<AttributeValue, { type: string }>;

/** Whether an attribute's value is a `{…}` expression, not a string or nothing. */
export const isExpression = (value: AttributeValue): value is ExpressionValue =>
  typeof value === "object" && value !== null;

// An `on*` prop, and a body that may hold one with an expression value.
const EVENT_HANDLER = /^on[A-Z]/u;
const HANDLER_HINT = /\son[A-Z]\w*\s*=\s*\{/u;
// An expression that is only a string literal, which renders as that string.
const STRING_LITERAL = /^\s*(?<quote>["'`])[\s\S]*\k<quote>\s*$/u;
// An intrinsic element: a lowercase name, not a member like `motion.div`.
const HTML_ELEMENT = /^[a-z][\w-]*$/u;

// A built-in that shows its children, opened with props and either closed at
// once or closed with nothing between the tags. Attribute values may hold
// `>`, so quoted strings and one level of braces are skipped whole.
const CHILDLESS_HINT = new RegExp(
  String.raw`<(?<tag>${[...BUILTIN_CHILD_PROPS.keys()].join("|")})\s(?:[^<>"'{}]|"[^"]*"|'[^']*'|\{[^{}]*\})*(?:\/>|>\s*<\/\k<tag>>)`,
  "u"
);

/** Whether an element has nothing to show between its tags. */
const isChildless = (node: JsxElement): boolean =>
  node.children.every(
    (child) => child.type === "text" && child.value.trim() === ""
  );

/** The handler props on an HTML element that hold a JavaScript value. */
const handlerProps = (node: JsxElement): string[] =>
  node.attributes.flatMap((attribute) =>
    attribute.type === "mdxJsxAttribute" &&
    EVENT_HANDLER.test(attribute.name) &&
    isExpression(attribute.value) &&
    !STRING_LITERAL.test(attribute.value.value)
      ? [attribute.name]
      : []
  );

/**
 * The props a childless built-in gets but doesn't take. A spread
 * (`{...props}`) could pass anything, so it counts as none; an Astro
 * directive (`client:load`, `set:html`) isn't a prop.
 */
const unknownProps = (node: JsxElement, accepted: readonly string[]) => {
  if (
    !isChildless(node) ||
    node.attributes.some((attribute) => attribute.type !== "mdxJsxAttribute")
  ) {
    return [];
  }
  return node.attributes.flatMap((attribute) =>
    attribute.type === "mdxJsxAttribute" &&
    !attribute.name.includes(":") &&
    !accepted.includes(attribute.name)
      ? [attribute.name]
      : []
  );
};

/** What `node` carries that doesn't render as written, if anything. */
const elementUse = (
  node: JsxElement,
  lineOffset: number
): ElementUse | undefined => {
  const tag = node.name ?? "";
  const accepted = BUILTIN_CHILD_PROPS.get(tag);
  let kind: ElementUse["kind"] = "prop";
  let props: string[] = [];
  if (HTML_ELEMENT.test(tag)) {
    kind = "handler";
    props = handlerProps(node);
  } else if (accepted) {
    props = unknownProps(node, accepted);
  }
  const start = node.position?.start;
  return props.length > 0
    ? {
        column: start?.column ?? 1,
        kind,
        line: (start?.line ?? 1) + lineOffset,
        props,
        tag,
      }
    : undefined;
};

// The last body parsed and its tree, `null` when MDX couldn't parse it.
let lastParse: { body: string; tree: Nodes | null } | undefined;

/**
 * An `.mdx` body's tree, or `null` for a body MDX can't parse (it fails to
 * render with its own error). The last body's tree is kept, because a scan
 * hands the same body to this module's walk and to `extractComponentAnchors`
 * (`component-anchors.ts`) in a row. Callers only read the tree.
 */
export const parseMdxBody = (body: string): Nodes | null => {
  if (lastParse?.body !== body) {
    let tree: Nodes | null;
    try {
      tree = mdxToMdast(body, { features: MDX_BODY_FEATURES });
    } catch {
      tree = null;
    }
    lastParse = { body, tree };
  }
  return lastParse.tree;
};

/**
 * Every element in an `.mdx` body whose props don't render as written (see
 * the module comment), in source order, its line shifted by `lineOffset`. The
 * body is parsed only when a cheap test finds a suspect, and a body MDX can't
 * parse fails to render with its own error, so it yields none.
 */
export const extractElementUses = (
  body: string,
  lineOffset = 0
): ElementUse[] => {
  if (!(HANDLER_HINT.test(body) || CHILDLESS_HINT.test(body))) {
    return [];
  }
  const tree = parseMdxBody(body);
  if (!tree) {
    return [];
  }
  const uses: ElementUse[] = [];
  const walk = (node: Nodes): void => {
    if (
      node.type === "mdxJsxFlowElement" ||
      node.type === "mdxJsxTextElement"
    ) {
      const use = elementUse(node, lineOffset);
      if (use) {
        uses.push(use);
      }
    }
    if ("children" in node) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  walk(tree);
  return uses;
};

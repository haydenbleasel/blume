import { mdxToMdast } from "satteri";

import { parseYouTubeId } from "../components/content/youtube.ts";

/**
 * Downlevel Blume's MDX components to plain Markdown for agent-facing output
 * (the `/<route>.md` mirror, llms-full.txt, MCP `get_page`). Each supported
 * component has a serializer — its "toString" — that renders the same
 * information as the Astro component, but as portable Markdown: `<TypeTable>`
 * becomes a GFM table, `<Callout>` a blockquote, `<Steps>` an ordered list,
 * `<Tabs>` labeled sections, `<YouTube>` a link.
 *
 * The transform is a position splice, not a re-stringify: the MDX source is
 * parsed to MDAST (via Satteri, which stamps byte offsets on every node) and
 * only the matched component ranges are replaced, so all surrounding Markdown
 * stays byte-identical to what the author wrote. Anything the serializers
 * can't faithfully convert — an unknown component, a prop bound to an import —
 * is left as JSX, and fenced code that merely *shows* component markup is
 * naturally untouched because it parses as a `code` node.
 */

/** Minimal structural MDAST types — we model only what this module reads. */
interface Offset {
  offset: number;
}

interface MdastNode {
  attributes?: MdxAttribute[];
  children?: MdastNode[];
  name?: string;
  position?: { end: Offset; start: Offset };
  type: string;
}

interface MdxAttribute {
  name?: string;
  type: string;
  value?: string | { type: string; value: string } | null;
}

/** A single source replacement: `[start, end)` byte range → `text`. */
interface Splice {
  end: number;
  start: number;
  text: string;
}

/** Evaluated props plus whether any attribute resisted static evaluation. */
interface EvaluatedProps {
  lossy: boolean;
  props: Record<string, unknown>;
}

/** A child component extracted by name (e.g. each `<Step>` under `<Steps>`). */
export interface ComponentMarkdownChild extends EvaluatedProps {
  /** The child's body, downleveled and dedented. */
  children: string;
}

/** What a serializer receives for one component usage. */
export interface ComponentMarkdownContext extends EvaluatedProps {
  /** Direct child components of `name`, each with evaluated props and body. */
  childComponents: (name: string) => ComponentMarkdownChild[];
  /** The element's body, downleveled and dedented (empty if self-closing). */
  children: string;
  /**
   * The page's parsed front-matter (empty when the caller has none). Lets a
   * serializer read page metadata directly, even when a prop expression is
   * not statically evaluable.
   */
  frontmatter: Record<string, unknown>;
}

/**
 * A component's Markdown serializer. Return the replacement Markdown, or
 * `null` to leave the component's JSX in the output verbatim (the safe
 * fallback when the props can't be recovered statically).
 */
export type ComponentMarkdown = (
  context: ComponentMarkdownContext
) => string | null;

/**
 * Statically evaluate an MDX attribute expression (`prop={...}`). Component
 * data props are object/array/number literals in practice; evaluation runs at
 * build time over the author's own content — the same trust level as the MDX
 * itself, which Astro compiles and executes. The page's `frontmatter` is in
 * scope, mirroring what Astro provides an MDX body at render time, so
 * `prop={frontmatter.status}` resolves; expressions that reference imports or
 * other scope throw and report as not evaluable.
 */
const evaluateExpression = (
  raw: string,
  frontmatter: Record<string, unknown> | undefined
): { ok: boolean; value: unknown } => {
  try {
    // Build-time eval of the author's own attribute literals; a throw falls
    // back to leaving the JSX verbatim.
    // oxlint-disable-next-line no-new-func
    const value = new Function("frontmatter", `"use strict"; return (${raw});`)(
      frontmatter
    );
    return { ok: true, value };
  } catch {
    return { ok: false, value: undefined };
  }
};

/** Evaluate an element's attributes into a plain props object. */
const readProps = (
  node: MdastNode,
  frontmatter: Record<string, unknown> | undefined
): EvaluatedProps => {
  const props: Record<string, unknown> = {};
  let lossy = false;
  for (const attribute of node.attributes ?? []) {
    // A spread ({...props}) can't be recovered statically.
    if (attribute.type !== "mdxJsxAttribute" || !attribute.name) {
      lossy = true;
      continue;
    }
    if (attribute.value === null || attribute.value === undefined) {
      // Boolean shorthand: `<Steps compact>`.
      props[attribute.name] = true;
    } else if (typeof attribute.value === "string") {
      props[attribute.name] = attribute.value;
    } else {
      const result = evaluateExpression(attribute.value.value, frontmatter);
      if (result.ok) {
        props[attribute.name] = result.value;
      } else {
        lossy = true;
      }
    }
  }
  return { lossy, props };
};

const hasOffsets = (
  node: MdastNode
): node is MdastNode & { position: { end: Offset; start: Offset } } =>
  typeof node.position?.start?.offset === "number" &&
  typeof node.position?.end?.offset === "number";

/** Apply non-overlapping splices to `text` (offsets relative to `text`). */
const applySplices = (text: string, splices: Splice[]): string => {
  let result = text;
  for (const splice of [...splices].toSorted((a, b) => b.start - a.start)) {
    // An element indented under a parent starts mid-line after whitespace;
    // repeat that indent on the replacement's continuation lines so the block
    // stays uniformly indented (and dedents cleanly with its siblings).
    const lineStart = result.lastIndexOf("\n", splice.start - 1) + 1;
    const prefix = result.slice(lineStart, splice.start);
    const indent = /^[\t ]+$/u.test(prefix) ? prefix : "";
    const replacement = indent
      ? splice.text
          .split("\n")
          .map((line, index) =>
            index === 0 || line === "" ? line : `${indent}${line}`
          )
          .join("\n")
      : splice.text;
    result =
      result.slice(0, splice.start) + replacement + result.slice(splice.end);
  }
  return result;
};

/**
 * Strip the common indentation JSX children carry in source (`<Step>` bodies
 * are typically indented two spaces under their tag). The first line starts
 * mid-line at the slice boundary, so the common prefix is measured on the
 * following lines only.
 */
const dedent = (text: string): string => {
  const lines = text.split("\n");
  const rest = lines.slice(1).filter((line) => line.trim() !== "");
  if (rest.length === 0) {
    return text;
  }
  const indent = Math.min(
    ...rest.map((line) => line.length - line.trimStart().length)
  );
  if (indent === 0) {
    return text;
  }
  return [
    lines[0],
    ...lines
      .slice(1)
      .map((line) => (line.trim() === "" ? "" : line.slice(indent))),
  ].join("\n");
};

const isJsxElement = (node: MdastNode): boolean =>
  node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";

/** Flatten a value to a single Markdown table cell (pipes escaped). */
const cellText = (value: unknown): string =>
  String(value ?? "")
    .replaceAll(/\s*\n\s*/gu, " ")
    .replaceAll("|", "\\|")
    .trim();

/** A cell rendered as inline code, unless the value itself uses backticks. */
const cellCode = (value: unknown): string => {
  const text = cellText(value);
  return text && !text.includes("`") ? `\`${text}\`` : text;
};

/** One `<TypeTable type={{...}}>` entry, matching the component's shape. */
interface TypeEntry {
  default?: unknown;
  description?: unknown;
  required?: unknown;
  type?: unknown;
  typeDescription?: unknown;
  typeDescriptionLink?: unknown;
}

const typeTable: ComponentMarkdown = ({ children, props }) => {
  const { type } = props;
  if (type === null || typeof type !== "object") {
    // The data prop is missing or wasn't statically evaluable.
    return null;
  }
  const entries = Object.entries(type as Record<string, TypeEntry>);
  const rows = entries.map(([name, info]) => {
    const prop = cellCode(`${name}${info.required ? "" : "?"}`);
    const typeCell = info.typeDescriptionLink
      ? `[${cellCode(info.type)}](${cellText(info.typeDescriptionLink)})`
      : cellCode(info.type);
    const defaultCell =
      info.default === undefined ? "-" : cellCode(info.default);
    const description = cellText(
      [info.description, info.typeDescription]
        .filter((part) => typeof part === "string" && part !== "")
        .join(" ")
    );
    return `| ${prop} | ${typeCell} | ${defaultCell} | ${description} |`;
  });
  const table =
    rows.length > 0
      ? [
          "| Prop | Type | Default | Description |",
          "| --- | --- | --- | --- |",
          ...rows,
        ].join("\n")
      : "";
  // The component renders its slot after the table.
  return [table, children].filter(Boolean).join("\n\n");
};

const callout: ComponentMarkdown = ({ children, props }) => {
  const type = typeof props.type === "string" ? props.type : "info";
  const label =
    typeof props.title === "string" && props.title !== ""
      ? props.title
      : type.charAt(0).toUpperCase() + type.slice(1);
  if (!children) {
    return `> **${label}**`;
  }
  const body = children
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
  return `> **${label}**\n>\n${body}`;
};

/** Format `content` as one ordered-list item, continuation lines indented. */
const listItem = (index: number, content: string): string => {
  const marker = `${index}. `;
  return content
    .split("\n")
    .map((line, lineIndex) => {
      if (lineIndex === 0) {
        return `${marker}${line}`;
      }
      return line === "" ? "" : `    ${line}`;
    })
    .join("\n");
};

const steps: ComponentMarkdown = ({ childComponents, children }) => {
  const items = childComponents("Step");
  if (items.length === 0) {
    return children;
  }
  return items
    .map((step, index) => {
      const title =
        typeof step.props.title === "string" && step.props.title !== ""
          ? `**${step.props.title}**`
          : "";
      const content = [title, step.children].filter(Boolean).join("\n\n");
      return listItem(index + 1, content);
    })
    .join("\n\n");
};

const tabs: ComponentMarkdown = ({ childComponents, children }) => {
  const items = childComponents("Tab");
  if (items.length === 0) {
    return children;
  }
  return items
    .map((tab, index) => {
      const title =
        typeof tab.props.title === "string" && tab.props.title !== ""
          ? tab.props.title
          : `Tab ${index + 1}`;
      return tab.children ? `**${title}**\n\n${tab.children}` : `**${title}**`;
    })
    .join("\n\n");
};

const youtube: ComponentMarkdown = ({ props }) => {
  let input = "";
  if (typeof props.id === "string") {
    input = props.id;
  } else if (typeof props.url === "string") {
    input = props.url;
  }
  const videoId = parseYouTubeId(input);
  if (!videoId) {
    return null;
  }
  const start =
    typeof props.start === "number" && props.start > 0
      ? `&t=${Math.floor(props.start)}s`
      : "";
  const title =
    typeof props.title === "string" && props.title !== ""
      ? props.title
      : "Watch on YouTube";
  return `[${title}](https://www.youtube.com/watch?v=${videoId}${start})`;
};

/**
 * The built-in serializer registry, keyed by JSX name. `Step` and `Tab` are
 * intentionally absent: they only carry meaning inside their containers,
 * which extract them via `childComponents`; a stray one stays verbatim.
 */
const SERIALIZERS: Record<string, ComponentMarkdown> = {
  Callout: callout,
  Steps: steps,
  Tabs: tabs,
  TypeTable: typeTable,
  YouTube: youtube,
};

const escapeRegExp = (value: string): string =>
  value.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

// Skip the MDX parse when no serializable component name appears at all —
// the common case for prose pages, and it keeps plain-Markdown sources (where
// `<`/`{` may be literal text MDX would reject) out of the parser entirely.
const componentHint = (registry: Record<string, ComponentMarkdown>): RegExp =>
  new RegExp(
    `<(?:${Object.keys(registry).map(escapeRegExp).join("|")})[\\s/>]`,
    "u"
  );

const BUILT_IN_HINT = componentHint(SERIALIZERS);

/** One downlevel pass's inputs: the source, registry, and page metadata. */
interface Walk {
  frontmatter: Record<string, unknown> | undefined;
  registry: Record<string, ComponentMarkdown>;
  source: string;
}

/**
 * The element's body as Markdown: the verbatim source slice covering its
 * children, with any serializable descendant components downleveled in place.
 * Mutually recursive with {@link collectSplices} (a container's children may
 * hold further serializable components), hence the forward reference.
 */
const renderChildren = (walk: Walk, node: MdastNode): string => {
  const children = (node.children ?? []).filter(hasOffsets);
  const [first] = children;
  if (!first) {
    return "";
  }
  const start = first.position.start.offset;
  const end = children.at(-1)?.position.end.offset ?? start;
  const splices: Splice[] = [];
  // oxlint-disable-next-line no-use-before-define
  collectSplices(walk, children, splices);
  const spliced = applySplices(
    walk.source.slice(start, end),
    splices.map((splice) => ({
      ...splice,
      end: splice.end - start,
      start: splice.start - start,
    }))
  );
  return dedent(spliced).trim();
};

/** Serialize one component usage, or `null` to keep its JSX verbatim. */
const serializeElement = (
  serializer: ComponentMarkdown,
  walk: Walk,
  node: MdastNode
): string | null =>
  serializer({
    ...readProps(node, walk.frontmatter),
    childComponents: (name) =>
      (node.children ?? [])
        .filter((child) => isJsxElement(child) && child.name === name)
        .map((child) => ({
          ...readProps(child, walk.frontmatter),
          children: renderChildren(walk, child),
        })),
    children: renderChildren(walk, node),
    frontmatter: walk.frontmatter ?? {},
  });

/**
 * Walk the tree collecting replacements. A replaced element's subtree is
 * owned by its serializer (which downlevels its own children), so the walk
 * doesn't descend into it; when a serializer declines, the walk continues
 * inside so nested serializable components still convert.
 */
const collectSplices = (
  walk: Walk,
  nodes: MdastNode[],
  out: Splice[]
): void => {
  for (const node of nodes) {
    const serializer =
      node.type === "mdxJsxFlowElement" && node.name
        ? walk.registry[node.name]
        : undefined;
    if (serializer && hasOffsets(node)) {
      const text = serializeElement(serializer, walk, node);
      if (text !== null) {
        out.push({
          end: node.position.end.offset,
          start: node.position.start.offset,
          text,
        });
        continue;
      }
    }
    collectSplices(walk, node.children ?? [], out);
  }
};

/**
 * Downlevel supported components in an MDX source to plain Markdown. Sources
 * with no supported components — and sources Satteri can't parse as MDX, e.g.
 * plain `.md` with literal `<`/`{` — are returned byte-identical.
 *
 * `components` adds user serializers from `ai.markdownComponents`, layered
 * over the built-ins: a same-name entry replaces the built-in serializer, and
 * one that always returns `null` effectively opts that component out.
 *
 * `frontmatter` is the page's parsed front-matter data. It is put in scope
 * when evaluating attribute expressions — so `prop={frontmatter.status}`
 * resolves the way it does when Astro renders the page — and handed to
 * serializers on their context.
 */
export const downlevelComponents = (
  source: string,
  components?: Record<string, ComponentMarkdown>,
  frontmatter?: Record<string, unknown>
): string => {
  const custom = components && Object.keys(components).length > 0;
  const registry = custom ? { ...SERIALIZERS, ...components } : SERIALIZERS;
  const hint = custom ? componentHint(registry) : BUILT_IN_HINT;
  if (!hint.test(source)) {
    return source;
  }
  let tree: MdastNode;
  try {
    tree = mdxToMdast(source) as MdastNode;
  } catch {
    return source;
  }
  const splices: Splice[] = [];
  collectSplices(
    { frontmatter, registry, source },
    tree.children ?? [],
    splices
  );
  return splices.length > 0 ? applySplices(source, splices) : source;
};

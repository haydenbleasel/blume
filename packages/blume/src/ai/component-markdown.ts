import { markdownTable } from "markdown-table";
import { mdxToMdast } from "satteri";

import { PARAM_LOCATIONS } from "../components/content/api-field.ts";
import { parseYouTubeId } from "../components/content/youtube.ts";
import type { ExampleLookup } from "../core/types.ts";
import { MDX_FEATURES } from "../markdown/features.ts";
import { readStaticExpression } from "./static-expression.ts";

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

/** The structural slice of an mdast node the downlevel walk reads. */
export interface MdastNode {
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
  /**
   * The range is a flow (block-level) element, so the line after it must
   * start a block of its own.
   */
  block: boolean;
  end: number;
  start: number;
  text: string;
}

/** Text that continues on the very next line, with no blank line between. */
const NEXT_LINE_TEXT = /^[\t ]*\n[\t ]*\S/u;

/**
 * A statically-recovered data value. Parsed front matter and evaluated
 * attribute literals are both plain data — scalars, dates, arrays, and
 * nested maps — never functions or class instances.
 */
export type EvaluatedValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date
  | EvaluatedValue[]
  | { [key: string]: EvaluatedValue };

export const isString = <Value>(value: Value): value is Value & string =>
  typeof value === "string";

const isNumber = <Value>(value: Value): value is Value & number =>
  typeof value === "number";

/** A nested map of evaluated values — an object literal prop, not a date or a list. */
const isValueMap = (
  value: EvaluatedValue
): value is { [key: string]: EvaluatedValue } =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date);

/** Evaluated props plus whether any attribute resisted static evaluation. */
interface EvaluatedProps {
  lossy: boolean;
  props: Record<string, EvaluatedValue>;
}

/** A child component extracted by name (e.g. each `<Step>` under `<Steps>`). */
export interface ComponentMarkdownChild extends EvaluatedProps {
  /** The child's body, downleveled and dedented. */
  children: string;
}

/** One direct child of a component — a child component or prose — as Markdown. */
export interface ComponentMarkdownBlock {
  /**
   * The child downleveled: a serializable component's rendering (through the
   * registry, so a user override of that component applies), or — for prose,
   * a component with no serializer, or one that declined — its source with
   * any serializable descendants downleveled in place.
   */
  markdown: string;
  /** The JSX name of a child component; `undefined` for prose. */
  name?: string;
}

/** What a serializer receives for one component usage. */
export interface ComponentMarkdownContext extends EvaluatedProps {
  /**
   * Every direct child of the element in document order, components and
   * prose alike, each as a block of Markdown. For a container that is nothing
   * but its contents — `<CardGroup>` — joining these with blank lines is the
   * whole serializer.
   */
  childBlocks: () => ComponentMarkdownBlock[];
  /** Direct child components of `name`, each with evaluated props and body. */
  childComponents: (name: string) => ComponentMarkdownChild[];
  /** The element's body, downleveled and dedented (empty if self-closing). */
  children: string;
  /**
   * The page's parsed front-matter (empty when the caller has none). Lets a
   * serializer read page metadata directly, even when a prop expression is
   * not statically evaluable.
   */
  frontmatter: Record<string, EvaluatedValue>;
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
 * Read an element's attributes into a plain props object. An expression
 * attribute (`prop={...}`) is read as literal data and never executed (see
 * `static-expression.ts`): the downleveler also runs over plain `.md` pages
 * and remote content, which nothing else executes. `prop={frontmatter.status}`
 * resolves against the page's front matter, as it does when Astro renders
 * the page; anything else — a call, an import — marks the props lossy.
 */
const readProps = (
  node: MdastNode,
  frontmatter: Record<string, EvaluatedValue> | undefined
): EvaluatedProps => {
  const props: Record<string, EvaluatedValue> = {};
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
    } else if (isString(attribute.value)) {
      props[attribute.name] = attribute.value;
    } else {
      const result = readStaticExpression(attribute.value.value, frontmatter);
      if (result.ok) {
        props[attribute.name] = result.value;
      } else {
        lossy = true;
      }
    }
  }
  return { lossy, props };
};

/** A node Satteri stamped with byte offsets. */
type Positioned = MdastNode & { position: { end: Offset; start: Offset } };

const hasOffsets = (node: MdastNode): node is Positioned =>
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
    // The JSX's closing tag ended its block; the Markdown standing in for it
    // doesn't. Text on the very next line would read as a lazy continuation
    // of a blockquote or list item (`> Body` then `Next.` joins the quote),
    // so a blank line keeps it out.
    const spliced =
      splice.block &&
      splice.text !== "" &&
      NEXT_LINE_TEXT.test(result.slice(splice.end))
        ? `${splice.text}\n`
        : splice.text;
    const replacement = indent
      ? spliced
          .split("\n")
          .map((line, index) =>
            index === 0 || line === "" ? line : `${indent}${line}`
          )
          .join("\n")
      : spliced;
    result =
      result.slice(0, splice.start) + replacement + result.slice(splice.end);
  }
  return result;
};

/**
 * Strip the common indentation JSX children carry in source (`<Step>` bodies
 * are typically indented two spaces under their tag). The first line starts
 * mid-line at the slice boundary, already past its own indent, so that indent
 * is passed in as `firstIndent` when it is known — the whitespace before the
 * slice — and counts toward the common prefix. Without it a nested list
 * (`- a` then `  - b`) would lose its nesting: the deeper following lines
 * alone would set the prefix. When the slice starts after other text on its
 * line (`<Step>Body…`), only the following lines are measured.
 */
const dedent = (text: string, firstIndent?: number): string => {
  const lines = text.split("\n");
  const rest = lines.slice(1).filter((line) => line.trim() !== "");
  if (rest.length === 0) {
    return text;
  }
  const indent = Math.min(
    ...rest.map((line) => line.length - line.trimStart().length),
    ...(firstIndent === undefined ? [] : [firstIndent])
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

/**
 * The indent of the line `offset` sits on, when everything before `offset` on
 * that line is whitespace; `undefined` when the offset follows other text.
 */
const indentAt = (source: string, offset: number): number | undefined => {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const prefix = source.slice(lineStart, offset);
  return /^[\t ]*$/u.test(prefix) ? prefix.length : undefined;
};

const isJsxElement = (node: MdastNode): boolean =>
  node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";

/** Flatten a value to a single Markdown table cell (pipes escaped). */
const cellText = (value: EvaluatedValue): string =>
  String(value ?? "")
    .replaceAll(/\s*\n\s*/gu, " ")
    .replaceAll("|", "\\|")
    .trim();

/** A cell rendered as inline code, unless the value itself uses backticks. */
const cellCode = (value: EvaluatedValue): string => {
  const text = cellText(value);
  return text && !text.includes("`") ? `\`${text}\`` : text;
};

/**
 * One `<TypeTable type={{...}}>` entry, matching the component's props. The
 * index signature keeps the interface interchangeable with the evaluated
 * data-value maps it is narrowed from.
 */
interface TypeEntry {
  [field: string]: EvaluatedValue;
  default?: EvaluatedValue;
  description?: EvaluatedValue;
  required?: EvaluatedValue;
  type?: EvaluatedValue;
  typeDescription?: EvaluatedValue;
  typeDescriptionLink?: EvaluatedValue;
}

/**
 * The `type` data prop's entry map. Structural only: each entry's fields are
 * rendered through cellText/cellCode, which stringify any value.
 */
const isTypeEntryMap = (
  value: EvaluatedValue
): value is Record<string, TypeEntry> =>
  typeof value === "object" && value !== null;

const typeTable: ComponentMarkdown = ({ children, props }) => {
  const { type } = props;
  if (!isTypeEntryMap(type)) {
    // The data prop is missing or wasn't statically evaluable.
    return null;
  }
  const entries = Object.entries(type);
  const rows = entries.map(([name, info]) => {
    const prop = cellCode(`${name}${info.required ? "" : "?"}`);
    const typeCell = info.typeDescriptionLink
      ? `[${cellCode(info.type)}](${cellText(info.typeDescriptionLink)})`
      : cellCode(info.type);
    const defaultCell =
      info.default === undefined ? "-" : cellCode(info.default);
    const description = cellText(
      [info.description, info.typeDescription]
        .filter((part) => isString(part) && part !== "")
        .join(" ")
    );
    return [prop, typeCell, defaultCell, description];
  });
  const table =
    rows.length > 0
      ? markdownTable([["Prop", "Type", "Default", "Description"], ...rows], {
          // Unpadded columns: cells hold prose and the output is for model
          // consumption, so aligned delimiter rows are wasted tokens.
          alignDelimiters: false,
        })
      : "";
  // The component renders its slot after the table.
  return [table, children].filter(Boolean).join("\n\n");
};

const callout: ComponentMarkdown = ({ children, props }) => {
  const type = isString(props.type) ? props.type : "info";
  const label =
    isString(props.title) && props.title !== ""
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
        isString(step.props.title) && step.props.title !== ""
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
        isString(tab.props.title) && tab.props.title !== ""
          ? tab.props.title
          : `Tab ${index + 1}`;
      return tab.children ? `**${title}**\n\n${tab.children}` : `**${title}**`;
    })
    .join("\n\n");
};

/**
 * A `<View>` block: its content under its view's name, so an agent reading
 * the Markdown sees every view and which one each part belongs to.
 */
const view: ComponentMarkdown = ({ children, props }) => {
  const title = isString(props.title) && props.title !== "" ? props.title : "";
  if (!title) {
    return children;
  }
  return children ? `**${title}**\n\n${children}` : `**${title}**`;
};

/** Escape the brackets that would end a link's text early. */
const linkText = (value: string): string =>
  value.replaceAll(/[[\]]/gu, String.raw`\$&`);

/**
 * A link destination. Whitespace ends one, and a `)` ends one unless it is
 * part of a balanced pair — so an href carrying either goes in the angle
 * bracket form, where only `<` and `>` are special.
 */
export const linkDestination = (href: string): string =>
  /[\s()<>]/u.test(href)
    ? `<${href.replaceAll(/[<>]/gu, String.raw`\$&`)}>`
    : href;

/** A text prop: a string, or a number stringified — `title={2024}` is a title. */
const textProp = (value: EvaluatedValue): string => {
  if (isString(value)) {
    return value.trim();
  }
  return isNumber(value) ? String(value) : "";
};

/** Whether a flag prop is on: shorthand `true`, or the string `"true"`. */
const flagOn = (value: EvaluatedValue): boolean =>
  value === true || value === "true";

/** A prop that holds one label or several. */
const labelList = (value: EvaluatedValue): string[] =>
  (Array.isArray(value) ? value : [value]).map(textProp).filter(Boolean);

/**
 * One `<ParamField>` or `<ResponseField>` as a list item: its labels, name,
 * location, type, flags, and default on the first line, joined with middle
 * dots, and its description indented under it, nested fields included. A
 * field with no name, or a prop that wouldn't evaluate, declines.
 */
const apiField = (
  { children, lossy, props }: ComponentMarkdownContext,
  name: string,
  location?: string
): string | null => {
  if (lossy || name === "") {
    return null;
  }
  const value = props.default;
  const head = [
    ...labelList(props.pre),
    `**${cellCode(name)}**`,
    ...labelList(props.post),
    location,
    textProp(props.type) && cellCode(props.type),
    flagOn(props.required) ? "required" : "",
    flagOn(props.deprecated) ? "deprecated" : "",
    value === undefined || value === null || value === ""
      ? ""
      : `default ${cellCode(isString(value) ? value : JSON.stringify(value))}`,
  ].filter(Boolean);
  const item = `- ${head.join(" · ")}`;
  if (!children) {
    return item;
  }
  const body = children
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n");
  return `${item}\n\n${body}`;
};

/** `<ParamField query="limit">`: named by its location attribute, else `name`. */
const paramFieldMarkdown: ComponentMarkdown = (context) => {
  const location = PARAM_LOCATIONS.find((key) => isString(context.props[key]));
  return location
    ? apiField(context, textProp(context.props[location]), location)
    : apiField(context, textProp(context.props.name));
};

const responseFieldMarkdown: ComponentMarkdown = (context) =>
  apiField(context, textProp(context.props.name));

/**
 * A card is a link with a blurb, so that is what it becomes: the title as the
 * link text, the body under it, and the call to action last — the order the
 * card renders in. Shaped like {@link tabs}, a bold label over the body,
 * rather than a heading: a card sits inside a page whose outline its author
 * wrote, and a heading would add a level to it.
 *
 * The icon and image are presentation and drop out. A card with no title
 * falls back to its `href`, and one with neither is just its body. `lossy`
 * declines: a title or href recovered from an expression that would not
 * evaluate is a link pointing somewhere wrong, which is worse than the
 * visible JSX.
 */
const card: ComponentMarkdown = ({ children, lossy, props }) => {
  if (lossy) {
    return null;
  }
  const title = textProp(props.title);
  const href = isString(props.href) ? props.href.trim() : "";
  const body = children.trim();
  const cta = textProp(props.cta);
  const label = title || href;
  if (label === "") {
    // Nothing to head the card with, so it is whatever text it carries.
    const rest = [body, cta].filter(Boolean).join("\n\n");
    // Nothing but presentation left — keep the JSX rather than delete a card.
    return rest === "" ? null : rest;
  }
  const head =
    href === ""
      ? `**${label}**`
      : `**[${linkText(label)}](${linkDestination(href)})**`;
  return [head, body, cta].filter(Boolean).join("\n\n");
};

/**
 * `CardGroup` is the grid its cards sit in and carries no meaning of its own,
 * so it becomes its contents: every direct child in order, each a block, a
 * blank line between them. Built on `childBlocks` rather than extracting the
 * cards so nothing the group holds is lost — a `Card` renders through the
 * registry (a user override of `Card` applies in here too), a nested group
 * recurses, prose between the cards stays, and a card that declines keeps its
 * JSX as a block of its own instead of vanishing beside a rendered sibling.
 * Passing the body slice through instead would leave each card's source
 * indentation in the output and run one card's title straight on from the
 * previous card's body as the same paragraph. The other containers that are
 * only layout — `Accordion`, `Columns`, `CodeGroup`, the `Color` palette —
 * serialize the same way; a child that renders to nothing (an unlabeled
 * `Icon`) leaves no gap.
 */
const cardGroup: ComponentMarkdown = ({ childBlocks }) =>
  childBlocks()
    .map((block) => block.markdown)
    .filter(Boolean)
    .join("\n\n");

const youtube: ComponentMarkdown = ({ props }) => {
  let input = "";
  if (isString(props.id)) {
    input = props.id;
  } else if (isString(props.url)) {
    input = props.url;
  }
  const videoId = parseYouTubeId(input);
  if (!videoId) {
    return null;
  }
  const start =
    isNumber(props.start) && props.start > 0
      ? `&t=${Math.floor(props.start)}s`
      : "";
  const title =
    isString(props.title) && props.title !== ""
      ? props.title
      : "Watch on YouTube";
  return `[${title}](https://www.youtube.com/watch?v=${videoId}${start})`;
};

/**
 * `text` as an inline code span whose delimiter outlengths any backtick run
 * inside it, padded with a space when the content starts or ends with a
 * backtick (CommonMark strips one such pair) — so a spec path or address
 * carrying a backtick cannot close the span early.
 */
export const inlineCode = (text: string): string => {
  const runs = text.match(/`+/gu);
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  const delimiter = "`".repeat(longest + 1);
  const padded =
    text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
  return `${delimiter}${padded}${delimiter}`;
};

/** Fence `code` so its opening/closing run outlengths any backticks inside. */
const fencedBlock = (lang: string, code: string): string => {
  const trimmed = code.replace(/(?<!\n)\n+$/u, "");
  const runs = trimmed.match(/`+/gu);
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${trimmed}\n${fence}`;
};

/**
 * Build the `<Component>` serializer for a project's discovered examples. The
 * live preview can't survive the trip to Markdown, so the agent-facing output
 * carries the example's source — the same code the "Code" tab shows — as a
 * fenced block. An unknown `path` (or a missing `path` prop) declines, leaving
 * the JSX verbatim, mirroring the "no example found" note the component renders
 * on the page.
 */
export const exampleComponentSerializers = (examples: ExampleLookup) =>
  ({
    Component: ({ props }) => {
      const path = isString(props.path) ? props.path : undefined;
      const example = path === undefined ? undefined : examples[path];
      return example ? fencedBlock(example.lang, example.source) : null;
    },
  }) satisfies Record<string, ComponentMarkdown>;

/** A bold label over a body — the shape {@link tabs} and {@link card} use. */
const labeled = (label: string, ...parts: string[]): string =>
  [label === "" ? "" : `**${label}**`, ...parts]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");

/**
 * A disclosure — `AccordionItem`, and `Expandable` with its "Show more"
 * default — is its title over its body, open: an agent reads what a reader
 * would have to click for. A title that wouldn't evaluate declines.
 */
const disclosure = (
  { children, lossy, props }: ComponentMarkdownContext,
  fallbackTitle: string
): string | null =>
  lossy
    ? null
    : labeled(
        textProp(props.title) || fallbackTitle,
        textProp(props.description),
        children
      );

const accordionItem: ComponentMarkdown = (context) => disclosure(context, "");

const expandable: ComponentMarkdown = (context) =>
  disclosure(context, "Show more");

/** `Frame` is its slot, with the hint above and the caption below as text. */
const frame: ComponentMarkdown = ({ children, props }) =>
  [textProp(props.hint), children, textProp(props.caption)]
    .filter(Boolean)
    .join("\n\n");

/** A layout wrapper whose body is the whole of its meaning. */
const body: ComponentMarkdown = ({ children }) => children;

/** `Panel` is a titled aside: its title over its body. */
const panel: ComponentMarkdown = ({ children, props }) =>
  labeled(textProp(props.title), children);

/**
 * `Tile` is a card with a preview, so it takes {@link card}'s shape: the
 * title as the link, then the description and the slot.
 */
const tile: ComponentMarkdown = ({ children, lossy, props }) => {
  if (lossy) {
    return null;
  }
  const title = textProp(props.title);
  const href = isString(props.href) ? props.href.trim() : "";
  const label = title || href;
  const head =
    href === ""
      ? labeled(label)
      : `**[${linkText(label)}](${linkDestination(href)})**`;
  const text = [head, textProp(props.description), children]
    .filter(Boolean)
    .join("\n\n");
  return text === "" ? null : text;
};

/**
 * `Update` is one changelog entry: its label (or title) as the head, linked
 * when it has its own page, then the description, tags, and notes.
 */
const update: ComponentMarkdown = ({ children, lossy, props }) => {
  if (lossy) {
    return null;
  }
  const label = textProp(props.label) || textProp(props.title) || "Update";
  const href = isString(props.href) ? props.href.trim() : "";
  const head =
    href === ""
      ? `**${label}**`
      : `**[${linkText(label)}](${linkDestination(href)})**`;
  const tags = (Array.isArray(props.tags) ? props.tags : [props.tags])
    .map(textProp)
    .filter(Boolean);
  return [
    head,
    textProp(props.description),
    tags.length > 0 ? `Tags: ${tags.join(", ")}` : "",
    children,
  ]
    .filter(Boolean)
    .join("\n\n");
};

/**
 * `Prompt` is a prompt to copy: its description as the label, and the prompt
 * itself quoted, the way a {@link callout} quotes its body.
 */
const prompt: ComponentMarkdown = ({ children, props }) => {
  const quoted = children
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
  return labeled(
    textProp(props.description) || "Prompt",
    children ? quoted : ""
  );
};

/**
 * `GithubInfo` is a card for one repository, so it becomes a link to it. The
 * site-wide repo the component falls back to isn't in reach here, so a card
 * without `owner` and `repo` declines.
 */
const githubInfo: ComponentMarkdown = ({ lossy, props }) => {
  const owner = textProp(props.owner);
  const repo = textProp(props.repo);
  if (lossy || owner === "" || repo === "") {
    return null;
  }
  const host = (textProp(props.host) || "https://github.com").replace(
    /\/+$/u,
    ""
  );
  return `[${linkText(`${owner}/${repo}`)}](${linkDestination(`${host}/${owner}/${repo}`)})`;
};

/** `CodeBlock` is a fenced block, its title kept in the fence's meta. */
const codeBlock: ComponentMarkdown = ({ lossy, props }) => {
  if (lossy || !isString(props.code)) {
    return null;
  }
  const lang = textProp(props.lang) || "txt";
  const title = textProp(props.title);
  return fencedBlock(
    title === "" ? lang : `${lang} title=${JSON.stringify(title)}`,
    props.code
  );
};

/**
 * `Diff` from an inline patch is that patch, fenced as `diff`; from `old` and
 * `new` strings, both sides fenced in turn. A diff read from files (`src`,
 * `before`/`after`) needs the file system, so it declines.
 */
const diff: ComponentMarkdown = ({ lossy, props }) => {
  if (lossy) {
    return null;
  }
  if (isString(props.patch)) {
    return fencedBlock("diff", props.patch);
  }
  if (isString(props.old) && isString(props.new)) {
    const lang = textProp(props.lang);
    return [
      labeled("Before", fencedBlock(lang, props.old)),
      labeled("After", fencedBlock(lang, props.new)),
    ].join("\n\n");
  }
  return null;
};

/** `Math` is its TeX source, as a display block or inline span. */
const math: ComponentMarkdown = ({ lossy, props }) => {
  if (lossy || !isString(props.code)) {
    return null;
  }
  return props.display === true ? `$$\n${props.code}\n$$` : `$${props.code}$`;
};

/** An `Icon` is decoration; one with an accessible label keeps the label. */
const icon: ComponentMarkdown = ({ props }) => textProp(props.label);

/** A `Badge` is its text. */
const badge: ComponentMarkdown = ({ children }) => children;

/**
 * A `Tooltip` is its trigger text followed by the tip, which is otherwise
 * only on hover: `term (tip)`, with the headline leading the tip.
 */
const tooltip: ComponentMarkdown = ({ children, lossy, props }) => {
  const tip = [textProp(props.headline), textProp(props.tip)]
    .filter(Boolean)
    .join(": ");
  if (lossy || tip === "") {
    return null;
  }
  return children ? `${children} (${tip})` : tip;
};

/** Indent a list block's lines under its parent item. */
const nested = (block: string): string =>
  block
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");

/**
 * `Tree` is the nested list it draws: each folder an item with a trailing
 * slash and its entries indented under it, each file an item.
 */
const treeList: ComponentMarkdown = ({ childBlocks }) =>
  childBlocks()
    .map((block) => block.markdown)
    .join("\n");

const treeFolder: ComponentMarkdown = ({ childBlocks, lossy, props }) => {
  const name = textProp(props.name);
  if (lossy || name === "") {
    return null;
  }
  const entries = childBlocks()
    .map((block) => nested(block.markdown))
    .join("\n");
  return entries === "" ? `- ${name}/` : `- ${name}/\n${entries}`;
};

const treeFile: ComponentMarkdown = ({ lossy, props }) => {
  const name = textProp(props.name);
  return lossy || name === "" ? null : `- ${name}`;
};

/**
 * A `Color.Item` is its name and value — both values when the light and dark
 * themes differ — and a `Color.Row` its title over its items.
 */
const colorItem: ComponentMarkdown = ({ lossy, props }) => {
  const name = textProp(props.name);
  const { value } = props;
  if (lossy || name === "") {
    return null;
  }
  if (isString(value)) {
    return `- **${name}**: ${inlineCode(value)}`;
  }
  if (!isValueMap(value)) {
    return null;
  }
  const light = textProp(value.light);
  const dark = textProp(value.dark);
  if (light === "" && dark === "") {
    return null;
  }
  const shown =
    light && dark && light !== dark
      ? `${inlineCode(light)} (light), ${inlineCode(dark)} (dark)`
      : inlineCode(light || dark);
  return `- **${name}**: ${shown}`;
};

const colorRow: ComponentMarkdown = ({ childBlocks, props }) =>
  labeled(
    textProp(props.title),
    childBlocks()
      .map((block) => block.markdown)
      .join("\n")
  );

/**
 * The built-in serializer registry, keyed by JSX name. `Step` and `Tab` are
 * intentionally absent: they only carry meaning inside their containers,
 * which extract them via `childComponents`; a stray one stays verbatim.
 * `AutoTypeTable` is absent too: its table comes from type-checking a source
 * file, which a serializer can't do synchronously, so it stays as JSX.
 */
const SERIALIZERS = {
  Accordion: cardGroup,
  AccordionItem: accordionItem,
  Badge: badge,
  Callout: callout,
  Card: card,
  CardGroup: cardGroup,
  CodeBlock: codeBlock,
  CodeGroup: cardGroup,
  Color: cardGroup,
  "Color.Item": colorItem,
  "Color.Row": colorRow,
  Column: body,
  Columns: cardGroup,
  Diff: diff,
  Expandable: expandable,
  FileTree: body,
  Frame: frame,
  GithubInfo: githubInfo,
  Icon: icon,
  Math: math,
  Panel: panel,
  ParamField: paramFieldMarkdown,
  Prompt: prompt,
  RequestExample: cardGroup,
  ResponseExample: cardGroup,
  ResponseField: responseFieldMarkdown,
  Steps: steps,
  Tabs: tabs,
  Tile: tile,
  Tooltip: tooltip,
  Tree: treeList,
  "Tree.File": treeFile,
  "Tree.Folder": treeFolder,
  TypeTable: typeTable,
  Update: update,
  View: view,
  YouTube: youtube,
} satisfies Record<string, ComponentMarkdown>;

/**
 * The built-ins that sit inside a line of prose, and so are downleveled as
 * text elements too: each renders to a single line.
 */
const INLINE_COMPONENTS = new Set(["Badge", "Icon", "Math", "Tooltip"]);

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
/** What a downlevel walk needs: the serializers, the page's front matter, and the source its nodes were parsed from. */
export interface DownlevelWalk {
  frontmatter: Record<string, EvaluatedValue> | undefined;
  registry: Record<string, ComponentMarkdown>;
  source: string;
}
type Walk = DownlevelWalk;

/** The serializer registry for a site: built-ins under a user's `agents.markdownComponents`. */
export const componentRegistry = (
  components?: Record<string, ComponentMarkdown>
): Record<string, ComponentMarkdown> =>
  components && Object.keys(components).length > 0
    ? { ...SERIALIZERS, ...components }
    : SERIALIZERS;

/**
 * A source slice as Markdown: the verbatim `[start, end)` range with any
 * serializable component under `nodes` downleveled in place, dedented and
 * trimmed. Mutually recursive with {@link collectSplices} (the nodes may hold
 * further serializable components), hence the forward reference.
 */
const renderSlice = (
  walk: Walk,
  start: number,
  end: number,
  nodes: MdastNode[]
): string => {
  const splices: Splice[] = [];
  // oxlint-disable-next-line no-use-before-define
  collectSplices(walk, nodes, splices);
  // Start the slice at its line's indent, so a component that opens the
  // slice is indented like the lines after it once replaced (see
  // `applySplices`) and dedents with them; the final trim drops that indent
  // from the first line again.
  const indent = indentAt(walk.source, start);
  const from = start - (indent ?? 0);
  const spliced = applySplices(
    walk.source.slice(from, end),
    splices.map((splice) => ({
      ...splice,
      end: splice.end - from,
      start: splice.start - from,
    }))
  );
  return dedent(spliced, indent).trim();
};

/** The element's body as Markdown: the slice covering all of its children. */
const renderChildren = (walk: Walk, node: MdastNode): string => {
  const children = (node.children ?? []).filter(hasOffsets);
  const [first] = children;
  if (!first) {
    return "";
  }
  const start = first.position.start.offset;
  return renderSlice(
    walk,
    start,
    children.at(-1)?.position.end.offset ?? start,
    children
  );
};

/**
 * One direct child as a block of Markdown: a registered component's own
 * rendering, else — prose, an unknown component, or one that declined — its
 * source slice, the same choice {@link collectSplices} makes at the top level.
 */
const renderBlock = (walk: Walk, node: Positioned): string => {
  const serializer =
    isJsxElement(node) && node.name ? walk.registry[node.name] : undefined;
  const text = serializer
    ? // oxlint-disable-next-line no-use-before-define
      serializeElement(serializer, walk, node)
    : null;
  return (
    text ??
    renderSlice(
      walk,
      node.position.start.offset,
      node.position.end.offset,
      node.children ?? []
    )
  );
};

/** Serialize one component usage, or `null` to keep its JSX verbatim. */
const serializeElement = (
  serializer: ComponentMarkdown,
  walk: Walk,
  node: MdastNode
): string | null =>
  serializer({
    ...readProps(node, walk.frontmatter),
    childBlocks: () =>
      (node.children ?? []).filter(hasOffsets).map((child) => ({
        markdown: renderBlock(walk, child),
        name: isJsxElement(child) ? child.name : undefined,
      })),
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
/**
 * Downlevel one parsed component to the Markdown its serializer emits, or
 * `null` when the node isn't a component, has no serializer, or its
 * serializer declines. `walk.source` must be the text `node` was parsed from.
 */
export const downlevelComponentNode = (
  node: MdastNode,
  walk: DownlevelWalk
): string | null => {
  const block =
    node.type === "mdxJsxFlowElement" ||
    (node.type === "mdxJsxTextElement" &&
      INLINE_COMPONENTS.has(node.name ?? ""));
  const serializer = block && node.name ? walk.registry[node.name] : undefined;
  return serializer && hasOffsets(node)
    ? serializeElement(serializer, walk, node)
    : null;
};

const collectSplices = (
  walk: Walk,
  nodes: MdastNode[],
  out: Splice[]
): void => {
  for (const node of nodes) {
    const text = hasOffsets(node) ? downlevelComponentNode(node, walk) : null;
    if (text !== null && hasOffsets(node)) {
      out.push({
        block: node.type === "mdxJsxFlowElement",
        end: node.position.end.offset,
        start: node.position.start.offset,
        text,
      });
      continue;
    }
    collectSplices(walk, node.children ?? [], out);
  }
};

/**
 * Downlevel supported components in an MDX source to plain Markdown. Sources
 * with no supported components — and sources Satteri can't parse as MDX, e.g.
 * plain `.md` with literal `<`/`{` — are returned byte-identical.
 *
 * `components` adds user serializers from `agents.markdownComponents`, layered
 * over the built-ins: a same-name entry replaces the built-in serializer, and
 * one that always returns `null` effectively opts that component out.
 *
 * `frontmatter` is the page's parsed front-matter data. Attribute
 * expressions that reference it — `prop={frontmatter.status}` — resolve the
 * way they do when Astro renders the page, and it is handed to serializers on
 * their context. Expressions are read as literal data, never executed.
 */
export const downlevelComponents = (
  source: string,
  components?: Record<string, ComponentMarkdown>,
  frontmatter?: Record<string, EvaluatedValue>
): string => {
  const registry = componentRegistry(components);
  const hint =
    registry === SERIALIZERS ? BUILT_IN_HINT : componentHint(registry);
  if (!hint.test(source)) {
    return source;
  }
  let tree: MdastNode;
  try {
    // SAFETY: MdastNode is a structural subset of Satteri's mdast output —
    // every node carries `type`, and the walk reads only optional fields.
    tree = mdxToMdast(source, { features: MDX_FEATURES }) as MdastNode;
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

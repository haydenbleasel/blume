/**
 * Lexical (Payload's rich text editor) → Markdown. Covers the nodes Payload's
 * default features emit — paragraphs, headings, lists (bullet, numbered,
 * check), quotes, links, uploads, horizontal rules — and hands `block` /
 * `inlineBlock` nodes to a serializer keyed by their `blockType`, or notes
 * them in a comment.
 */
import type { JsonObject } from "./json.ts";
import { asNumber, asObject, asString, getPath, objectsIn } from "./json.ts";
import type { InlineMarks, InlinePart } from "./lower.ts";
import {
  absoluteUrl,
  blockquote,
  guardBlockStart,
  headingPrefix,
  image,
  indent,
  linkParts,
  listItem,
  markdownDocument,
  renderInline,
  unsupported,
  writesMdx,
} from "./lower.ts";

export interface LexicalOptions {
  /** The CMS origin a relative upload URL (`/media/x.png`) resolves against. */
  baseUrl?: string;
  /** Serializers for `block`/`inlineBlock` nodes, keyed by `fields.blockType`. */
  serializers?: Record<string, (fields: JsonObject) => string>;
}

// Lexical's text `format` bitmask.
const IS_BOLD = 1;
const IS_ITALIC = 2;
const IS_STRIKETHROUGH = 4;
const IS_CODE = 16;

/** Whether a power-of-two flag is set in the format bitmask. */
const hasFlag = (format: number, flag: number): boolean =>
  Math.floor(format / flag) % 2 === 1;

const marksOf = (node: JsonObject): InlineMarks => {
  const format = asNumber(node.format) ?? 0;
  return {
    bold: hasFlag(format, IS_BOLD),
    code: hasFlag(format, IS_CODE),
    italic: hasFlag(format, IS_ITALIC),
    strike: hasFlag(format, IS_STRIKETHROUGH),
  };
};

const children = (node: JsonObject): JsonObject[] => objectsIn(node.children);

const typeOf = (node: JsonObject): string => asString(node.type) ?? "";

const customBlock = (node: JsonObject, options: LexicalOptions): string => {
  const fields = asObject(node.fields);
  const blockType = fields ? asString(fields.blockType) : undefined;
  const serializer = blockType ? options.serializers?.[blockType] : undefined;
  if (fields && serializer) {
    return serializer(fields);
  }
  return unsupported(
    `Lexical block${blockType ? `: ${blockType}` : ""}`,
    writesMdx(options.serializers)
  );
};

const inlineParts = (
  nodes: JsonObject[],
  options: LexicalOptions
): InlinePart[] =>
  // oxlint-disable-next-line no-use-before-define -- mutual recursion: a link's label is itself inline content
  nodes.flatMap((node) => inlineNodeParts(node, options));

const inlineNodeParts = (
  node: JsonObject,
  options: LexicalOptions
): InlinePart[] => {
  switch (typeOf(node)) {
    case "text": {
      return [{ marks: marksOf(node), text: asString(node.text) ?? "" }];
    }
    case "linebreak": {
      return [{ markdown: "\n" }];
    }
    case "tab": {
      return [{ markdown: "\t" }];
    }
    case "link":
    case "autolink": {
      // `fields.url` on Payload 3; `url` on older Lexical payloads. An
      // internal link (`linkType: "internal"`) carries a document, not a
      // URL, so its label stays.
      return linkParts(
        inlineParts(children(node), options),
        asString(getPath(node, "fields.url")) ?? asString(node.url)
      );
    }
    case "inlineBlock": {
      return [{ markdown: customBlock(node, options) }];
    }
    default: {
      return inlineParts(children(node), options);
    }
  }
};

/** Inline nodes as Markdown, guarded as one block. */
const inlineText = (nodes: JsonObject[], options: LexicalOptions): string =>
  guardBlockStart(renderInline(inlineParts(nodes, options)));

/** A text block's inline children, joined and guarded as one block. */
const blockText = (node: JsonObject, options: LexicalOptions): string =>
  inlineText(children(node), options);

const renderUpload = (node: JsonObject, options: LexicalOptions): string => {
  const value = asObject(node.value);
  const url = value ? asString(value.url) : undefined;
  if (!(value && url)) {
    return unsupported(
      "Lexical upload (fetch with depth 1 to populate it)",
      writesMdx(options.serializers)
    );
  }
  const alt = asString(value.alt) ?? asString(value.filename) ?? "";
  return image(alt, absoluteUrl(url, options.baseUrl));
};

const renderList = (node: JsonObject, options: LexicalOptions): string => {
  const listType = asString(node.listType) ?? "bullet";
  const start = asNumber(node.start) ?? 1;
  const items: string[] = [];
  let lastMarker = "-";
  let index = 0;
  for (const item of children(node)) {
    const kids = children(item);
    const nested = kids.filter((kid) => typeOf(kid) === "list");
    const inline = kids.filter((kid) => typeOf(kid) !== "list");
    const sub = nested.map((list) => renderList(list, options)).join("\n");
    if (inline.length === 0 && nested.length > 0) {
      // Lexical nests a sub-list as its own item holding only the list; it
      // hangs under the item before it, or stands alone when there is none.
      items.push(items.length > 0 ? indent(sub, lastMarker.length + 1) : sub);
      continue;
    }
    lastMarker = listType === "number" ? `${start + index}.` : "-";
    let check = "";
    if (listType === "check") {
      check = item.checked === true ? "[x] " : "[ ] ";
    }
    const line = `${check}${inlineText(inline, options)}`;
    items.push(listItem(lastMarker, sub ? `${line}\n${sub}` : line));
    index += 1;
  }
  return items.join("\n");
};

const renderBlock = (node: JsonObject, options: LexicalOptions): string => {
  switch (typeOf(node)) {
    case "paragraph": {
      return blockText(node, options);
    }
    case "heading": {
      const level = Number((asString(node.tag) ?? "h1").slice(1));
      return `${headingPrefix(level)}${blockText(node, options)}`;
    }
    case "quote": {
      return blockquote(blockText(node, options));
    }
    case "list": {
      return renderList(node, options);
    }
    case "horizontalrule": {
      return "---";
    }
    case "upload": {
      return renderUpload(node, options);
    }
    case "block": {
      return customBlock(node, options);
    }
    default: {
      return unsupported(
        `Lexical node: ${typeOf(node)}`,
        writesMdx(options.serializers)
      );
    }
  }
};

/**
 * Serialize a Lexical editor state (`{ root: { children } }`, or the root
 * node itself) to Markdown.
 */
export const lexicalToMarkdown = (
  state: JsonObject,
  options: LexicalOptions = {}
): string => {
  const root = asObject(state.root) ?? state;
  return markdownDocument(
    children(root).map((node) => renderBlock(node, options))
  );
};

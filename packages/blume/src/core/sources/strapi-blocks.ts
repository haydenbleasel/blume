/**
 * Strapi's Rich text (Blocks) field → Markdown. Covers every block the
 * editor emits: paragraphs, headings, lists (nested), quotes, code, images,
 * and links with the text modifiers.
 */
import type { JsonObject, JsonValue } from "./json.ts";
import { asNumber, asObject, asString, objectsIn } from "./json.ts";
import type { InlinePart } from "./lower.ts";
import {
  absoluteUrl,
  blockquote,
  codeFence,
  guardBlockStart,
  headingPrefix,
  image,
  linkParts,
  listItem,
  markdownDocument,
  renderInline,
  unsupported,
} from "./lower.ts";

export interface StrapiBlocksOptions {
  /** The Strapi origin a relative upload URL (`/uploads/x.png`) resolves against. */
  baseUrl?: string;
}

const children = (node: JsonObject): JsonObject[] => objectsIn(node.children);

const typeOf = (node: JsonObject): string => asString(node.type) ?? "";

const inlineParts = (nodes: JsonObject[]): InlinePart[] =>
  // oxlint-disable-next-line no-use-before-define -- mutual recursion: a link's label is itself inline content
  nodes.flatMap((node) => inlineNodeParts(node));

const inlineNodeParts = (node: JsonObject): InlinePart[] => {
  switch (typeOf(node)) {
    case "text": {
      return [
        {
          marks: {
            bold: node.bold === true,
            code: node.code === true,
            italic: node.italic === true,
            strike: node.strikethrough === true,
          },
          text: asString(node.text) ?? "",
        },
      ];
    }
    case "link": {
      return linkParts(inlineParts(children(node)), asString(node.url));
    }
    default: {
      return inlineParts(children(node));
    }
  }
};

/** A text block's inline nodes, joined and guarded as one block. */
const blockText = (nodes: JsonObject[]): string =>
  guardBlockStart(renderInline(inlineParts(nodes)));

const renderList = (node: JsonObject): string => {
  const ordered = asString(node.format) === "ordered";
  return children(node)
    .map((item, index) => {
      const kids = children(item);
      const line = blockText(kids.filter((kid) => typeOf(kid) !== "list"));
      const sub = kids
        .filter((kid) => typeOf(kid) === "list")
        .map((list) => renderList(list))
        .join("\n");
      const body = sub ? `${line}\n${sub}` : line;
      return listItem(ordered ? `${index + 1}.` : "-", body);
    })
    .join("\n");
};

const renderImage = (
  node: JsonObject,
  options: StrapiBlocksOptions
): string => {
  const file = asObject(node.image);
  const url = file ? asString(file.url) : undefined;
  if (!(file && url)) {
    return "";
  }
  return image(
    asString(file.alternativeText) ?? asString(file.name) ?? "",
    absoluteUrl(url, options.baseUrl)
  );
};

const renderBlock = (
  node: JsonObject,
  options: StrapiBlocksOptions
): string => {
  switch (typeOf(node)) {
    case "paragraph": {
      return blockText(children(node));
    }
    case "heading": {
      return `${headingPrefix(asNumber(node.level) ?? 1)}${blockText(children(node))}`;
    }
    case "quote": {
      return blockquote(blockText(children(node)));
    }
    case "list": {
      return renderList(node);
    }
    case "code": {
      // Code children are plain text nodes; their text is literal.
      const code = children(node)
        .map((child) => asString(child.text) ?? "")
        .join("");
      return codeFence(code, asString(node.language) ?? "");
    }
    case "image": {
      return renderImage(node, options);
    }
    default: {
      return unsupported(`Strapi block: ${typeOf(node)}`);
    }
  }
};

/** Serialize a Blocks field value (an array of block nodes) to Markdown. */
export const strapiBlocksToMarkdown = (
  blocks: JsonValue,
  options: StrapiBlocksOptions = {}
): string =>
  markdownDocument(objectsIn(blocks).map((node) => renderBlock(node, options)));

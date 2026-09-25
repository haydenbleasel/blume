/**
 * Contentful rich text → Markdown. Covers the block, inline, and mark types
 * the Rich Text editor emits; embedded entries fall through to a serializer
 * keyed by content type or are noted in a comment. Links to assets and
 * entries arrive unresolved from the Delivery API (`data.target` is a
 * `sys` link), so the source hands in resolvers over the response's
 * `includes`; a document the SDK already resolved (with `fields` inline)
 * lowers the same way.
 */
import type { JsonObject } from "./json.ts";
import { asString, getPath, objectsIn } from "./json.ts";
import type { InlineMarks, InlinePart } from "./lower.ts";
import {
  absoluteUrl,
  blockquote,
  guardBlockStart,
  headingPrefix,
  image,
  joinBlocks,
  linkParts,
  listItem,
  markdownDocument,
  renderInline,
  unsupported,
  writesMdx,
} from "./lower.ts";

/** An asset's file as a Markdown image needs it. */
export interface ContentfulAsset {
  description?: string;
  title?: string;
  url: string;
}

export interface ContentfulRichTextOptions {
  /** Resolve an asset link (`data.target.sys.id`) to its file. */
  resolveAsset?: (id: string) => ContentfulAsset | null;
  /** Resolve an entry link to the entry (`sys` plus `fields`). */
  resolveEntry?: (id: string) => JsonObject | null;
  /**
   * Serializers for embedded entries, keyed by content type id; return
   * Markdown or MDX. Setting any writes the source's entries as MDX.
   */
  serializers?: Record<string, (entry: JsonObject) => string>;
}

const HEADING = /^heading-(?<level>[1-6])$/u;
const CELL_PIPE = /\|/gu;
const CELL_BREAK = /\n+/gu;

/** The file behind an asset entry, or null when it carries none. */
export const assetFromEntry = (asset: JsonObject): ContentfulAsset | null => {
  const url = asString(getPath(asset, "fields.file.url"));
  if (!url) {
    return null;
  }
  return {
    description: asString(getPath(asset, "fields.description")),
    title: asString(getPath(asset, "fields.title")),
    url: absoluteUrl(url),
  };
};

const children = (node: JsonObject): JsonObject[] => objectsIn(node.content);

const marksOf = (node: JsonObject): InlineMarks => {
  const marks: InlineMarks = {};
  for (const mark of objectsIn(node.marks)) {
    switch (asString(mark.type)) {
      case "bold": {
        marks.bold = true;
        break;
      }
      case "italic": {
        marks.italic = true;
        break;
      }
      case "code": {
        marks.code = true;
        break;
      }
      case "strikethrough": {
        marks.strike = true;
        break;
      }
      default:
    }
  }
  return marks;
};

/**
 * The linked object a node points at: inline when the document was resolved
 * (`data.target.fields`), else through the resolver by `data.target.sys.id`.
 */
const linkedTarget = (
  node: JsonObject,
  resolve?: (id: string) => JsonObject | null
): JsonObject | null => {
  const target = getPath(node, "data.target");
  if (getPath(node, "data.target.fields") !== undefined) {
    // SAFETY: `data.target.fields` resolved through the object, so `target`
    // is that object.
    return target as JsonObject;
  }
  const id = asString(getPath(node, "data.target.sys.id"));
  return id ? (resolve?.(id) ?? null) : null;
};

const linkedAsset = (
  node: JsonObject,
  options: ContentfulRichTextOptions
): ContentfulAsset | null => {
  if (getPath(node, "data.target.fields") !== undefined) {
    const inline = linkedTarget(node);
    return inline ? assetFromEntry(inline) : null;
  }
  const id = asString(getPath(node, "data.target.sys.id"));
  return id ? (options.resolveAsset?.(id) ?? null) : null;
};

const embeddedEntry = (
  node: JsonObject,
  options: ContentfulRichTextOptions
): string => {
  const entry = linkedTarget(node, options.resolveEntry);
  const contentType = entry
    ? asString(getPath(entry, "sys.contentType.sys.id"))
    : undefined;
  const serializer = contentType
    ? options.serializers?.[contentType]
    : undefined;
  if (entry && serializer) {
    return serializer(entry);
  }
  return unsupported(
    `Contentful embedded entry${contentType ? `: ${contentType}` : ""}`,
    writesMdx(options.serializers)
  );
};

const inlineParts = (
  nodes: JsonObject[],
  options: ContentfulRichTextOptions
): InlinePart[] =>
  // oxlint-disable-next-line no-use-before-define -- mutual recursion: a link's label is itself inline content
  nodes.flatMap((node) => inlineNodeParts(node, options));

const inlineNodeParts = (
  node: JsonObject,
  options: ContentfulRichTextOptions
): InlinePart[] => {
  switch (asString(node.nodeType)) {
    case "text": {
      return [{ marks: marksOf(node), text: asString(node.value) ?? "" }];
    }
    case "hyperlink": {
      return linkParts(
        inlineParts(children(node), options),
        asString(getPath(node, "data.uri"))
      );
    }
    case "asset-hyperlink": {
      return linkParts(
        inlineParts(children(node), options),
        linkedAsset(node, options)?.url
      );
    }
    case "embedded-entry-inline": {
      return [{ markdown: embeddedEntry(node, options) }];
    }
    default: {
      // entry-hyperlink (no route to point at) and anything unknown: the label.
      return inlineParts(children(node), options);
    }
  }
};

/** A block's inline children as Markdown, guarded as one block. */
const blockText = (
  node: JsonObject,
  options: ContentfulRichTextOptions
): string =>
  guardBlockStart(renderInline(inlineParts(children(node), options)));

const renderList = (
  items: JsonObject[],
  marker: (index: number) => string,
  options: ContentfulRichTextOptions
): string =>
  items
    .map((item, index) =>
      listItem(
        marker(index),
        // A single newline between an item's paragraph and its nested list
        // keeps the list tight.
        children(item)
          // oxlint-disable-next-line no-use-before-define -- mutual recursion: an item holds blocks, including nested lists
          .map((child) => renderBlock(child, options))
          .filter((block) => block !== "")
          .join("\n")
      )
    )
    .join("\n");

// Each of a cell's paragraphs is a block as much as a page's is, so it goes
// through the same guard: two struck runs in one still meet as `~~~~`.
const cellText = (
  cell: JsonObject,
  options: ContentfulRichTextOptions
): string =>
  children(cell)
    .map((paragraph) => blockText(paragraph, options))
    .join(" ")
    .replaceAll(CELL_BREAK, " ")
    .replaceAll(CELL_PIPE, String.raw`\|`);

const tableRow = (cells: string[]): string => `| ${cells.join(" | ")} |`;

const renderTable = (
  node: JsonObject,
  options: ContentfulRichTextOptions
): string => {
  const rows = children(node).map((row) =>
    children(row).map((cell) => cellText(cell, options))
  );
  const [head, ...body] = rows;
  if (!head) {
    return "";
  }
  return [
    tableRow(head),
    tableRow(head.map(() => "---")),
    ...body.map((cells) => tableRow(cells)),
  ].join("\n");
};

const renderBlock = (
  node: JsonObject,
  options: ContentfulRichTextOptions
): string => {
  const type = asString(node.nodeType) ?? "";
  const heading = HEADING.exec(type)?.groups?.level;
  if (heading) {
    return `${headingPrefix(Number(heading))}${blockText(node, options)}`;
  }
  switch (type) {
    case "paragraph": {
      return blockText(node, options);
    }
    case "blockquote": {
      return blockquote(
        joinBlocks(children(node).map((child) => renderBlock(child, options)))
      );
    }
    case "unordered-list": {
      return renderList(children(node), () => "-", options);
    }
    case "ordered-list": {
      return renderList(children(node), (index) => `${index + 1}.`, options);
    }
    case "hr": {
      return "---";
    }
    case "embedded-asset-block": {
      const asset = linkedAsset(node, options);
      // Contentful's own rich-text renderer uses the description as alt text
      // and the title only as a fallback.
      return asset
        ? image(asset.description ?? asset.title ?? "", asset.url)
        : "";
    }
    case "embedded-entry-block": {
      return embeddedEntry(node, options);
    }
    case "table": {
      return renderTable(node, options);
    }
    default: {
      return unsupported(
        `Contentful node: ${type}`,
        writesMdx(options.serializers)
      );
    }
  }
};

/** Serialize a rich text document (`nodeType: "document"`) to Markdown. */
export const contentfulRichTextToMarkdown = (
  doc: JsonObject,
  options: ContentfulRichTextOptions = {}
): string =>
  markdownDocument(children(doc).map((node) => renderBlock(node, options)));

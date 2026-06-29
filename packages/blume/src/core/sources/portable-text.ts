/**
 * A minimal Portable Text → Markdown serializer. Covers the standard block,
 * list, and mark types Sanity emits; custom block/mark types fall through to a
 * user-supplied serializer or are skipped with a noted comment. Output is
 * Markdown text that flows through Blume's normal pipeline.
 */

/** A single Portable Text node (block, image, or a custom type). */
export interface PortableTextBlock {
  _type: string;
  _key?: string;
  style?: string;
  listItem?: string;
  level?: number;
  children?: PortableTextSpan[];
  markDefs?: PortableTextMarkDef[];
  [key: string]: unknown;
}

interface PortableTextSpan {
  _type: string;
  text?: string;
  marks?: string[];
}

interface PortableTextMarkDef {
  _key: string;
  _type: string;
  href?: string;
}

export interface PortableTextOptions {
  /** Resolve an image block to a URL (the adapter knows project/dataset). */
  imageUrl?: (block: PortableTextBlock) => string | null;
  /** Custom block-type serializers, keyed by `_type`; return Markdown/MDX. */
  serializers?: Record<string, (block: PortableTextBlock) => string>;
}

const HEADING_STYLES: Record<string, string> = {
  h1: "# ",
  h2: "## ",
  h3: "### ",
  h4: "#### ",
  h5: "##### ",
  h6: "###### ",
};

/** Wrap a span's text in Markdown for its marks (decorators + link defs). */
const renderSpan = (
  span: PortableTextSpan,
  defs: Map<string, PortableTextMarkDef>
): string => {
  let text = span.text ?? "";
  if (!span.marks || span.marks.length === 0) {
    return text;
  }
  // Decorators wrap inline; a link def wraps last so its label keeps emphasis.
  let link: PortableTextMarkDef | undefined;
  for (const mark of span.marks) {
    switch (mark) {
      case "strong": {
        text = `**${text}**`;
        break;
      }
      case "em": {
        text = `*${text}*`;
        break;
      }
      case "code": {
        text = `\`${text}\``;
        break;
      }
      case "strike-through": {
        text = `~~${text}~~`;
        break;
      }
      default: {
        const def = defs.get(mark);
        if (def?._type === "link") {
          link = def;
        }
      }
    }
  }
  return link?.href ? `[${text}](${link.href})` : text;
};

/** Render the inline children of a block to a single Markdown string. */
const renderChildren = (block: PortableTextBlock): string => {
  const defs = new Map(
    (block.markDefs ?? []).map((def) => [def._key, def] as const)
  );
  return (block.children ?? []).map((span) => renderSpan(span, defs)).join("");
};

const renderBlock = (
  block: PortableTextBlock,
  options: PortableTextOptions
): string => {
  const custom = options.serializers?.[block._type];
  if (custom) {
    return custom(block);
  }
  if (block._type === "image") {
    const url = options.imageUrl?.(block);
    const alt = typeof block.alt === "string" ? block.alt : "";
    return url ? `![${alt}](${url})` : "";
  }
  if (block._type !== "block") {
    return `<!-- unsupported Portable Text block: ${block._type} -->`;
  }

  const inline = renderChildren(block);
  if (block.listItem) {
    const indent = "  ".repeat(Math.max(0, (block.level ?? 1) - 1));
    const marker = block.listItem === "number" ? "1." : "-";
    return `${indent}${marker} ${inline}`;
  }
  if (block.style === "blockquote") {
    return `> ${inline}`;
  }
  return `${HEADING_STYLES[block.style ?? "normal"] ?? ""}${inline}`;
};

/** Serialize a Portable Text array into a Markdown string. */
export const portableTextToMarkdown = (
  blocks: PortableTextBlock[],
  options: PortableTextOptions = {}
): string => {
  const lines = blocks.map((block) => renderBlock(block, options));
  // List items are single-newline separated; everything else gets a blank line.
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const prevList = Boolean(blocks[i - 1]?.listItem);
    const thisList = Boolean(blocks[i]?.listItem);
    if (i > 0) {
      out.push(prevList && thisList ? "\n" : "\n\n");
    }
    out.push(line);
  }
  return `${out.join("")}\n`;
};

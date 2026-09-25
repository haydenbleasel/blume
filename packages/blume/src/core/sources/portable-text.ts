/**
 * A minimal Portable Text → Markdown serializer. Covers the standard block,
 * list, and mark types Sanity emits; custom block/mark types fall through to a
 * user-supplied serializer or are skipped with a noted comment. Output is
 * Markdown text that flows through Blume's normal pipeline.
 */
import type { InlineRun } from "./lower.ts";
import {
  guardBlockStart,
  image,
  linkParts,
  renderInline,
  unsupported,
  writesMdx,
} from "./lower.ts";

/**
 * A field value on a Portable Text node: the arbitrary JSON the CMS query
 * returned (custom blocks carry whatever fields the studio schema defines).
 * Spans and mark defs appear as members so the block's typed fields conform
 * to its index signature.
 */
export type PortableTextValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | PortableTextSpan
  | PortableTextMarkDef
  | PortableTextValue[]
  | { [key: string]: PortableTextValue };

/** A single Portable Text node (block, image, or a custom type). */
export interface PortableTextBlock {
  _type: string;
  _key?: string;
  style?: string;
  listItem?: string;
  level?: number;
  children?: PortableTextSpan[];
  markDefs?: PortableTextMarkDef[];
  [key: string]: PortableTextValue;
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
  /**
   * Custom block-type serializers, keyed by `_type`; return Markdown or MDX.
   * Setting any writes the source's entries as MDX.
   */
  serializers?: Record<string, (block: PortableTextBlock) => string>;
}

const HEADING_STYLES = new Map([
  ["h1", "# "],
  ["h2", "## "],
  ["h3", "### "],
  ["h4", "#### "],
  ["h5", "##### "],
  ["h6", "###### "],
]);

/** A span's text and the marks Markdown has syntax for. */
const spanRun = (span: PortableTextSpan): InlineRun => {
  const marks = span.marks ?? [];
  return {
    marks: {
      bold: marks.includes("strong"),
      code: marks.includes("code"),
      italic: marks.includes("em"),
      strike: marks.includes("strike-through"),
    },
    text: span.text ?? "",
  };
};

/** Neighboring spans under one link def (or none), and that def. */
interface LinkedSpans {
  link?: PortableTextMarkDef;
  runs: InlineRun[];
}

/**
 * Render the inline children of a block to a single Markdown string, through
 * the shared lowering every CMS uses: prose is escaped, a code span outruns
 * the backticks inside it, edge whitespace stays outside emphasis, neighbors
 * share their marks' delimiters, and neighbors under one link def share one
 * link — wrapped last (so its label keeps emphasis), and only when its
 * destination is safe to click.
 */
const renderChildren = (block: PortableTextBlock): string => {
  const defs = new Map(
    (block.markDefs ?? []).map((def) => [def._key, def] as const)
  );
  const linked: LinkedSpans[] = [];
  for (const span of block.children ?? []) {
    const link = (span.marks ?? [])
      .map((mark) => defs.get(mark))
      .findLast((def) => def?._type === "link");
    const last = linked.at(-1);
    if (last && last.link === link) {
      last.runs.push(spanRun(span));
    } else {
      linked.push({ link, runs: [spanRun(span)] });
    }
  }
  return guardBlockStart(
    renderInline(
      linked.flatMap(({ link, runs }) => linkParts(runs, link?.href))
    )
  );
};

/** Whether an image block's `alt` field is usable alt text (CMS JSON may hold anything). */
const isAltText = (value: PortableTextValue): value is string =>
  typeof value === "string";

/** The marker a list block opens with. */
const listMarker = (block: PortableTextBlock): string =>
  block.listItem === "number" ? "1." : "-";

/**
 * How far each block is indented. Portable Text lists are flat blocks with a
 * `level`, while Markdown nests an item by indenting it to its parent item's
 * content column: two past a `-` item's indent, three past a `1.` item's. The
 * column comes from the item actually above, so a skipped level nests under
 * the deepest open item instead of indenting into a code block.
 */
const listIndents = (blocks: PortableTextBlock[]): number[] => {
  const columns: number[] = [];
  return blocks.map((block) => {
    if (!block.listItem) {
      columns.length = 0;
      return 0;
    }
    const depth = Math.min(Math.max(0, (block.level ?? 1) - 1), columns.length);
    const indent = columns[depth - 1] ?? 0;
    columns.length = depth;
    columns.push(indent + listMarker(block).length + 1);
    return indent;
  });
};

const renderBlock = (
  block: PortableTextBlock,
  options: PortableTextOptions,
  indent: number
): string => {
  const custom = options.serializers?.[block._type];
  if (custom) {
    return custom(block);
  }
  if (block._type === "image") {
    const url = options.imageUrl?.(block);
    const alt = isAltText(block.alt) ? block.alt : "";
    return url ? image(alt, url) : "";
  }
  if (block._type !== "block") {
    return unsupported(
      `Portable Text block: ${block._type}`,
      writesMdx(options.serializers)
    );
  }

  const inline = renderChildren(block);
  if (block.listItem) {
    return `${" ".repeat(indent)}${listMarker(block)} ${inline}`;
  }
  if (block.style === "blockquote") {
    return `> ${inline}`;
  }
  return `${HEADING_STYLES.get(block.style ?? "normal") ?? ""}${inline}`;
};

/** Serialize a Portable Text array into a Markdown string. */
export const portableTextToMarkdown = (
  blocks: PortableTextBlock[],
  options: PortableTextOptions = {}
): string => {
  const indents = listIndents(blocks);
  const lines = blocks.map((block, i) =>
    renderBlock(block, options, indents[i] ?? 0)
  );
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

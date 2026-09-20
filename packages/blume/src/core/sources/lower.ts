/**
 * Shared primitives for lowering a CMS's rich-text tree to Markdown text.
 * Every rich-text lowerer (Portable Text, Contentful, Lexical, Strapi
 * blocks) renders inline runs, wraps them in block syntax, and joins blocks
 * with blank lines; these helpers keep that Markdown identical across them.
 */

// Markdown/raw-HTML structure characters. Rich-text leaves are *plain text* —
// formatting arrives as marks, never as syntax in the text — so a literal
// `*`, `_`, `[`, backtick, `~`, or `<` typed in the CMS must render as
// itself. Unescaped, it opened emphasis or a code span mid-paragraph, and `<`
// let CMS prose inject raw HTML into the rendered page. CommonMark
// backslash-escapes every ASCII punctuation character, so `\*` is always the
// literal asterisk.
const MARKDOWN_SPECIALS = /[\\`*_[\]~<]/gu;

export const escapeMarkdownText = (text: string): string =>
  text.replaceAll(MARKDOWN_SPECIALS, String.raw`\$&`);

/** The marks a lowerer can put on an inline run. */
export interface InlineMarks {
  bold?: boolean;
  code?: boolean;
  italic?: boolean;
  strike?: boolean;
}

const EDGE_SPACE = /^(?<lead>\s*)(?<body>[\s\S]*?)(?<trail>\s*)$/u;

/**
 * Wrap a text run in the Markdown for its marks. Code stays verbatim inside
 * the backticks (an escape would render as a backslash); everything else is
 * escaped first. Whitespace at either edge moves outside the delimiters,
 * since `** bold **` is not strong emphasis but `**bold**` is — editors
 * routinely bold a word together with the space after it.
 */
export const renderInline = (text: string, marks: InlineMarks): string => {
  const match = EDGE_SPACE.exec(text);
  const lead = match?.groups?.lead ?? "";
  const body = match?.groups?.body ?? "";
  const trail = match?.groups?.trail ?? "";
  if (body === "") {
    return text;
  }
  let out = marks.code ? `\`${body}\`` : escapeMarkdownText(body);
  if (marks.bold) {
    out = `**${out}**`;
  }
  if (marks.italic) {
    out = `*${out}*`;
  }
  if (marks.strike) {
    out = `~~${out}~~`;
  }
  return `${lead}${out}${trail}`;
};

/** A Markdown link, or the label alone when the target is missing. */
export const renderLink = (label: string, href?: string): string =>
  href ? `[${label}](${href})` : label;

/** The ATX prefix for a heading level, clamped to Markdown's six. */
export const headingPrefix = (level: number): string =>
  `${"#".repeat(Math.min(Math.max(Math.trunc(level), 1), 6))} `;

/** Quote every line of a block. */
export const blockquote = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");

/**
 * A list item: the marker on the first line, and every continuation line
 * indented to the marker's width so nested blocks stay inside the item.
 */
export const listItem = (marker: string, body: string): string => {
  const [first = "", ...rest] = body.split("\n");
  const pad = " ".repeat(marker.length + 1);
  return [
    `${marker} ${first}`,
    ...rest.map((line) => (line === "" ? "" : `${pad}${line}`)),
  ].join("\n");
};

/** Indent every non-empty line, for a nested list hanging off an item. */
export const indent = (text: string, width: number): string => {
  const pad = " ".repeat(width);
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `${pad}${line}`))
    .join("\n");
};

const BACKTICK_RUN = /`+/gu;

/** A fenced code block whose fence outruns any backtick run in the code. */
export const codeFence = (code: string, language = ""): string => {
  let longest = 0;
  for (const run of code.match(BACKTICK_RUN) ?? []) {
    longest = Math.max(longest, run.length);
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${code}\n${fence}`;
};

/** A Markdown image; the alt is escaped so a `]` in a caption can't close it. */
export const image = (alt: string, url: string): string =>
  `![${escapeMarkdownText(alt)}](${url})`;

/** A comment marking a node the lowerer has no Markdown for. */
export const unsupported = (what: string): string =>
  `<!-- unsupported ${what} -->`;

/** Blocks separated by blank lines; empty blocks are dropped. */
export const joinBlocks = (blocks: string[]): string =>
  blocks.filter((block) => block !== "").join("\n\n");

/** A whole document: its blocks plus the trailing newline a file ends with. */
export const markdownDocument = (blocks: string[]): string =>
  `${joinBlocks(blocks)}\n`;

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/iu;

/**
 * A media URL as a static site can reference it. A protocol-relative
 * Contentful asset (`//images.ctfassets.net/…`) gets `https:`; a path a
 * self-hosted CMS serves (`/uploads/x.png`) resolves against the CMS origin.
 */
export const absoluteUrl = (url: string, base?: string): string => {
  if (url.startsWith("//")) {
    return `https:${url}`;
  }
  if (ABSOLUTE.test(url) || base === undefined) {
    return url;
  }
  return new URL(url, base).href;
};

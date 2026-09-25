/**
 * Shared primitives for lowering a CMS's rich-text tree to Markdown text.
 * Every rich-text lowerer (Portable Text, Contentful, Lexical, Strapi
 * blocks) renders inline runs, wraps them in block syntax, and joins blocks
 * with blank lines; these helpers keep that Markdown identical across them.
 */

import { isSafeHref } from "../safe-href.ts";

// Markdown/raw-HTML structure characters. Rich-text leaves are *plain text* —
// formatting arrives as marks, never as syntax in the text — so a literal
// `*`, `_`, `[`, backtick, `~`, `^`, or `<` typed in the CMS must render as
// itself. Unescaped, it opened emphasis, a code span, or a superscript
// (`2^10 and 2^20`) mid-paragraph, and `<` let CMS prose inject raw HTML into
// the rendered page. `{` and `}` open an expression once an entry is written
// as MDX (see {@link writesMdx}), and `$$` opens math there. CommonMark
// backslash-escapes every ASCII punctuation character, so `\*` is always the
// literal asterisk, in `.md` and `.mdx` alike.
const MARKDOWN_SPECIALS = /[\\`*_{}[\]~<$^]/gu;

// MDX reads a colon ahead of a letter or digit as a text directive (`10:30`,
// `og:image`, `pets:read`), so that colon is escaped too. One inside a bare
// URL (`http://localhost:3000`) stays as written: an escape there would end
// the autolink early.
const DIRECTIVE_COLON = /(?<!(?:[a-z][\w+.-]*:\/\/|www\.)\S*):(?=[a-z\d])/giu;

// GFM autolinks a bare `http://`, `https://`, or `www.` URL in prose, taking
// its characters verbatim up to the next space or `<`: an escape inside one
// reaches the href as a backslash (`a\_b`), so prose leaves a bare URL's
// characters as written. That includes a trailing `*`, `_`, or `~`, which
// GFM leaves out of the link: escaped, its backslash would still land inside.
// A link label is the exception — GFM links nothing inside one, so there
// every special is escaped (see `linkParts`).
const BARE_URL = /\b(?:https?:\/\/|www\.)[\w-][^\s<]*/giu;

// An entity or numeric character reference (`&copy;`, `&#38;`) is decoded
// even in plain text, so one typed in the CMS would render as the character
// it names rather than as written. A bare `&` is left alone.
const CHARACTER_REFERENCE = /&(?=#?[a-z0-9]+;)/giu;

// Block syntax is only syntax at the start of a line: `# ` (through
// `###### `), `- `, `+ ` and `1. `/`1) ` need the space (or line end) to
// become a heading or list item, while `>` opens a quote on its own, and a
// line of only `=` or `-` turns the line above it into a heading (or, alone,
// into a rule). Indentation of up to three spaces still counts. A CMS
// paragraph that begins with one of these — a soft break inside it counts as
// a line start too — must stay prose.
const BLOCK_START =
  /^(?<indent>[ \t]*)(?:(?<marker>#+|[+-]|\d+[.)])(?=[ \t]|$)|(?<quote>>)|(?<rule>=+|-{2,})(?=[ \t]*$))/gmu;

// MDX reads a top-level line that opens with `import` or `export` followed by
// a space, a tab, `{`, or `*` as an ESM statement, and prose like "import the
// CSV first" then fails the whole page. The keyword's first letter as a
// character reference renders the same in `.md` and `.mdx`, and MDX no longer
// sees the keyword. The keyword is escaped wherever a word ends on it, which
// covers every character that opens a statement. Only a block's first line
// counts; a blank line inside the text starts a new block.
const ESM_START = /(?<=^|\n[ \t]*\n)(?<keyword>import|export)(?![\w$])/gu;

// Whitespace opening a block: four columns of it (or a tab) make an indented
// code block, and a paragraph drops it when it renders anyway.
const BLOCK_INDENT = /(?<=^|\n[ \t]*\n)[ \t]+/gu;

const escapeBlockStart = (text: string): string =>
  text.replaceAll(BLOCK_START, (match: string, indent: string) => {
    // A numbered marker escapes its punctuation (`1\.`), the rest themselves.
    const marker = match.slice(indent.length);
    const index = marker.search(/[.)]/u);
    return index === -1
      ? `${indent}\\${marker}`
      : `${indent}${marker.slice(0, index)}\\${marker.slice(index)}`;
  });

const escapeEsmStart = (text: string): string =>
  text.replaceAll(
    ESM_START,
    (keyword: string) => `&#${keyword.codePointAt(0)};${keyword.slice(1)}`
  );

const escapeSpecials = (text: string): string =>
  text.replaceAll(MARKDOWN_SPECIALS, String.raw`\$&`);

/** The escapes that apply everywhere, once the specials are escaped. */
const escapeRest = (text: string): string =>
  escapeEsmStart(
    escapeBlockStart(
      text
        .replaceAll(DIRECTIVE_COLON, String.raw`\:`)
        .replaceAll(CHARACTER_REFERENCE, String.raw`\&`)
    )
  );

/**
 * CMS text as Markdown that renders as written, wherever it lands — a link
 * label included, where GFM autolinks nothing, so every special is escaped.
 */
export const escapeMarkdownText = (text: string): string =>
  escapeRest(escapeSpecials(text));

/** CMS prose as {@link escapeMarkdownText}, except inside a bare URL. */
const escapeProse = (text: string): string => {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(BARE_URL)) {
    out += escapeSpecials(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return escapeRest(out + escapeSpecials(text.slice(last)));
};

/** The marks a lowerer can put on an inline run. */
export interface InlineMarks {
  bold?: boolean;
  code?: boolean;
  italic?: boolean;
  strike?: boolean;
}

/** A run of CMS text and the marks on it. */
export interface InlineRun {
  marks: InlineMarks;
  text: string;
}

/** Inline Markdown a lowerer rendered itself: a link, an embed, a break. */
export interface InlineMarkdown {
  markdown: string;
}

/** One piece of a block's inline content, in order. */
export type InlinePart = InlineMarkdown | InlineRun;

const BACKTICK_RUN = /`+/gu;

/** The longest run of backticks in `text`, 0 when there is none. */
const longestBacktickRun = (text: string): number => {
  let longest = 0;
  for (const run of text.match(BACKTICK_RUN) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return longest;
};

/**
 * A code span whose delimiter outruns any backtick run inside it, padded with
 * a space on each side when the code starts or ends with a backtick (the
 * CommonMark rule that keeps the padding out of the rendered code).
 */
export const codeSpan = (code: string): string => {
  const fence = "`".repeat(longestBacktickRun(code) + 1);
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
};

// Two struck runs side by side meet as `~~~~`: a closer and an opener that
// GFM reads as one four-tilde run, so both print as literal tildes. A literal
// `~` is escaped outside a bare URL, so an unescaped `~~~~` outside a code
// span, a link destination, or a bare URL is exactly that seam, and dropping
// it merges the runs into one strikethrough. The other alternatives only step
// over escapes, code spans, destinations, and bare URLs so the seam is never
// matched inside them.
const SEAM_STEPS =
  /\\[\s\S]|(?<ticks>`+)[\s\S]*?(?<!`)\k<ticks>(?!`)|\]\((?:<(?:\\.|[^\\<>\n])*>|(?:\\.|[^\\\s)])+)\)/u;
const STRIKE_SEAM = new RegExp(
  `${SEAM_STEPS.source}|${BARE_URL.source}|~~~~`,
  "giu"
);

// A heading that ends in a space and a run of `#` reads that run as the
// optional closing sequence and drops it (`## Issue #` renders "Issue").
const CLOSING_HASHES = /(?<=[ \t])#+(?=[ \t]*$)/u;

/**
 * A block's inline text, guarded where only the whole block can tell. Runs
 * are escaped one at a time, but "import" ending one run and a space or code
 * span opening the next form an MDX `import` statement only once they are
 * joined, whitespace the first runs put in front of a block turns it into
 * an indented code block, two struck runs fuse into literal tildes, and a
 * trailing ` #` is a heading's closing sequence. Apply it to the joined text
 * of a paragraph, heading, quote, or list item — never to code.
 */
export const guardBlockStart = (text: string): string =>
  escapeEsmStart(
    text
      .replaceAll(BLOCK_INDENT, "")
      .replaceAll(STRIKE_SEAM, (match: string) =>
        match === "~~~~" ? "" : match
      )
      .replace(CLOSING_HASHES, String.raw`\$&`)
  );

const EDGE_SPACE = /^(?<lead>\s*)(?<body>[\s\S]*?)(?<trail>\s*)$/u;

/**
 * `text` with `render` applied between its edge whitespace, or as it is when
 * it is only whitespace.
 */
const betweenEdges = (
  text: string,
  render: (body: string) => string
): string => {
  const match = EDGE_SPACE.exec(text);
  const body = match?.groups?.body ?? "";
  if (body === "") {
    return text;
  }
  return `${match?.groups?.lead ?? ""}${render(body)}${match?.groups?.trail ?? ""}`;
};

const MARK_NAMES = ["bold", "code", "italic", "strike"] as const;

const sameMarks = (
  a: InlineMarks,
  b: InlineMarks,
  names: readonly (keyof InlineMarks)[] = MARK_NAMES
): boolean => names.every((mark) => Boolean(a[mark]) === Boolean(b[mark]));

/** A stretch of neighboring runs that share marks, and those marks. */
interface RunGroup {
  marks: InlineMarks;
  runs: InlineRun[];
}

/** Runs split into stretches of neighbors that share the `names` marks. */
const groupRuns = (
  runs: InlineRun[],
  names: readonly (keyof InlineMarks)[] = MARK_NAMES
): RunGroup[] => {
  const groups: RunGroup[] = [];
  for (const run of runs) {
    const group = groups.at(-1);
    if (group && sameMarks(group.marks, run.marks, names)) {
      group.runs.push(run);
    } else {
      groups.push({ marks: run.marks, runs: [run] });
    }
  }
  return groups;
};

/**
 * Consecutive text runs as Markdown. Neighbors with the same bold, italic,
 * and strikethrough share one set of delimiters — rendered one run at a
 * time, two bold runs met as `****` and two italic ones as `**`, which print
 * as literal asterisks. Code stays verbatim inside the backticks (an escape
 * would render as a backslash), and neighboring code joins into one span;
 * everything else is escaped. Whitespace at either edge moves outside the
 * delimiters, since `** bold **` is not strong emphasis but `**bold**` is —
 * editors routinely bold a word together with the space after it.
 */
const renderRuns = (
  runs: InlineRun[],
  escape: (text: string) => string
): string =>
  groupRuns(runs, ["bold", "italic", "strike"])
    .map(({ marks, runs: shared }) => {
      const inner = groupRuns(shared)
        .map((same) =>
          betweenEdges(same.runs.map((run) => run.text).join(""), (body) =>
            same.marks.code ? codeSpan(body) : escape(body)
          )
        )
        .join("");
      return betweenEdges(inner, (body) => {
        let out = body;
        if (marks.bold) {
          out = `**${out}**`;
        }
        if (marks.italic) {
          out = `*${out}*`;
        }
        if (marks.strike) {
          out = `~~${out}~~`;
        }
        return out;
      });
    })
    .join("");

/** Inline parts as Markdown, each stretch of runs through {@link renderRuns}. */
const renderParts = (
  parts: InlinePart[],
  escape: (text: string) => string
): string => {
  let out = "";
  let runs: InlineRun[] = [];
  for (const part of parts) {
    if ("markdown" in part) {
      out += renderRuns(runs, escape) + part.markdown;
      runs = [];
    } else {
      runs.push(part);
    }
  }
  return out + renderRuns(runs, escape);
};

/** A block's inline content as Markdown. */
export const renderInline = (parts: InlinePart[]): string =>
  renderParts(parts, escapeProse);

// A destination with whitespace, a control character, or parentheses ends
// early in `[label](…)`; CommonMark's pointy-bracket form carries it intact.
// oxlint-disable-next-line no-control-regex -- control characters are exactly what the bare form refuses.
const UNSAFE_DESTINATION = /[\s()\u0000-\u001F\u007F]/u;

// Markdown decodes a destination before the browser sees it: a backslash
// escape or a character reference becomes its character, so
// `java&#115;cript:` would reach the `href` as `javascript:` after the safety
// check passed it. Escaping both — and `<`/`>`, which would close the
// pointy form early and let the rest of the URL open a second link — keeps
// the `href` exactly the URL the CMS holds.
const DESTINATION_SPECIALS = /[\\<>]|&(?=#?[a-z0-9]+;)/giu;

// A destination can't hold a line break, and the URL parser drops tabs and
// line breaks anyway, so removing them leaves the same URL.
const DESTINATION_IGNORED = /[\t\n\r]/gu;

/** A link or image destination as Markdown carries it verbatim. */
export const destination = (url: string): string => {
  const escaped = url
    .replaceAll(DESTINATION_IGNORED, "")
    .replaceAll(DESTINATION_SPECIALS, String.raw`\$&`);
  return UNSAFE_DESTINATION.test(escaped) ? `<${escaped}>` : escaped;
};

/**
 * A Markdown link over inline parts, or the parts alone when the target is
 * missing — or unsafe: CMS content is the editor's, not the site author's, so
 * a destination that isn't a web, mail, or relative address (`javascript:`,
 * `data:`) never becomes a clickable link on the docs site (see
 * `safe-links.ts`). The parts stay parts then, so their runs merge with their
 * neighbors'. A label escapes a bare URL too: GFM autolinks nothing inside a
 * link, so its specials would read as syntax.
 */
export const linkParts = (parts: InlinePart[], href?: string): InlinePart[] =>
  href && isSafeHref(href)
    ? [
        {
          markdown: `[${renderParts(parts, escapeMarkdownText)}](${destination(href)})`,
        },
      ]
    : parts;

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

// A fence's language is one word of its info string. A backtick in it keeps
// the fence from opening at all, so the code renders as Markdown and HTML,
// and whitespace would start the meta Blume reads code titles from; a
// language that isn't a single such word is dropped.
const FENCE_LANGUAGE = /^[^\s`]+$/u;

/**
 * A fenced code block whose fence outruns any backtick run in the code,
 * labeled with its language when that is one word a fence can carry.
 */
export const codeFence = (code: string, language = ""): string => {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(code) + 1));
  const label = FENCE_LANGUAGE.test(language) ? language : "";
  return `${fence}${label}\n${code}\n${fence}`;
};

/** A Markdown image; the alt is escaped so a `]` in a caption can't close it. */
export const image = (alt: string, url: string): string =>
  `![${escapeMarkdownText(alt)}](${destination(url)})`;

/**
 * Whether a lowerer's output is written as MDX. Serializers are how a CMS
 * block becomes a Blume component, and components (like directives) only
 * render in MDX, so configuring any serializer switches the source's
 * rich-text bodies to `.mdx`. The escaping above keeps the rest of the
 * lowered text valid there.
 */
export const writesMdx = <Node>(
  serializers?: Record<string, (node: Node) => string>
): boolean => serializers !== undefined && Object.keys(serializers).length > 0;

// A node's type is the CMS's data too: a `*/` (or `--`) in it would close the
// comment early and let the rest run as MDX (or render as HTML). A space
// between the two characters keeps it inside.
const COMMENT_END = /\*\/|--/gu;

/**
 * A comment marking a node the lowerer has no Markdown for — an MDX comment
 * when the output is MDX, which rejects `<!-- -->`.
 */
export const unsupported = (what: string, mdx = false): string => {
  const label = what.replaceAll(COMMENT_END, (end) => [...end].join(" "));
  return mdx ? `{/* unsupported ${label} */}` : `<!-- unsupported ${label} -->`;
};

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

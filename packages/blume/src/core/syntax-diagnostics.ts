import { slug } from "github-slugger";
import type { Nodes } from "mdast";
import { markdownToMdast } from "satteri";

import { MARKDOWN_BODY_FEATURES } from "../markdown/features.ts";
import { nextFenceState } from "./code-fences.ts";
import type { FenceState } from "./code-fences.ts";
import {
  ATTRIBUTE,
  HTML_COMMENT,
  INLINE_CODE,
  strippedLineOffset,
  trailingCurlyMarker,
} from "./sources/normalize.ts";
import type { SourceEntry } from "./sources/types.ts";
import type { Diagnostic, PageRecord } from "./types.ts";

/**
 * Syntax from other docs tools that Blume doesn't read, found in a page body
 * outside code and comments. Each one either ships as literal text on a green
 * build or, in `.mdx`, breaks the page only once it renders, so it's reported
 * at its line instead:
 *
 * - `BLUME_TEMPLATE_TAG`: a Liquid or Markdoc tag (`{% include x %}`) or a
 *   Liquid output (`{{ site.title }}`) in `.md`. A `{{name}}` that could be a
 *   Blume variable is left to the variables pass.
 * - `BLUME_WIKILINK_UNSUPPORTED`: a wiki link (`[[Page]]`, `[[Text|Page]]`)
 *   to one of the site's pages, or any with a `|`. A bare `[[Name]]` that
 *   names no page is left alone: JavaScript docs write the spec's internal
 *   slots that way (`[[Prototype]]`). The Obsidian source rewrites its own
 *   links before this sees them.
 * - `BLUME_MDC_SYNTAX`: a Nuxt Content (MDC) block (`::callout` … `::`) or
 *   inline component (`:badge[New]{color="primary"}`).
 * - `BLUME_MDX_ATTRIBUTE_LIST`: an attribute list (`{ width="300" }`,
 *   `{ .class }`) in `.mdx`, which MDX reads as JavaScript.
 * - `BLUME_MD_ATTRIBUTE_LIST`: an attribute list in `.md`, kramdown's IAL
 *   (`{: .note }`) or MkDocs' `attr_list`, which shows as written. A heading's
 *   `{#id}` marker is left to `BLUME_MD_CURLY_ANCHOR`.
 * - `BLUME_MDX_UNCLOSED_ELEMENT`: a void element written as HTML (`<img …>`)
 *   in `.mdx`, which MDX reads as an unclosed JSX element.
 */

/** A problem at a line of the scanned text, before it's placed in a file. */
interface Finding {
  code: string;
  column: number;
  line: number;
  message: string;
  suggestion: string;
}

/** A match's position in the scanned text. */
interface Site {
  column: number;
  line: number;
}

/** The route of the page a wiki link names, if one does. */
type PageRoute = (name: string) => string | undefined;

/** What a check reads: the masked body, where its lines start, and the site's pages. */
interface Scan {
  pageRoute: PageRoute;
  starts: number[];
  text: string;
}

/** The site's pages by the names a wiki link can call them (see {@link wikiKey}). */
export type PageNameIndex = ReadonlyMap<string, readonly PageRecord[]>;

/** A backslash escapes the character after it, so only an even run is text. */
const UNESCAPED = String.raw`(?<=(?:^|[^\\])(?:\\\\)*)`;

// Liquid and Markdoc tags, and Liquid output, on one line.
const TEMPLATE_TAG = new RegExp(String.raw`${UNESCAPED}\{%[^\n]*?%\}`, "gu");
const TEMPLATE_OUTPUT = new RegExp(
  String.raw`${UNESCAPED}\{\{(?<expression>[^\n{}]*)\}\}`,
  "gu"
);
// What a Blume variable reference holds (see `variables.ts`).
const VARIABLE_REFERENCE = /^\s*[\w-]+\s*$/u;

// `[[Page]]` or `[[Text|Page]]`. An embed (`![[x]]`) and a link whose label
// is in brackets (`[[x]](/url)`, `[[x]][ref]`) aren't wiki links.
const WIKILINK = /(?<![!\\[])\[\[(?<inner>[^[\]\n]+)\]\](?![([:])/gu;

// An MDC block component opener on its own line: two colons, a name, and an
// optional `[slot]` and `{props}`. Three colons is a `:::` container.
const MDC_BLOCK =
  /^[\t ]*(?<written>::(?<name>[a-z][\w-]*)(?:\[[^\]\n]*\])?(?:\{[^}\n]*\})?)[\t ]*$/gimu;
// An inline MDC component: a colon and a name, then a `[slot]`, `{props}`,
// or both. A word character before the colon (`og:image`, `16:9`) is prose.
// Two colons is a block opener that shares its line with text, which no
// parser reads as a block.
const MDC_INLINE =
  /(?<![\w:\\])(?<written>:{1,2}(?<name>[a-z][\w-]*)(?:\[[^\]\n]*\](?:\{[^}\n]*\})?|\{[^}\n]*\}))/giu;

// A brace-wrapped attribute list (`{ width="300" }`, kramdown's `{: .note }`).
// After `=` it's a JSX attribute's value (`style={…}`).
const ATTRIBUTE_LIST = new RegExp(
  String.raw`(?<![=\\])\{:?[\t ]*${ATTRIBUTE}(?:[\t ]+${ATTRIBUTE})*[\t ]*\}`,
  "gu"
);
// A directive's `{attributes}` (`:::note{title="x"}`, `::name{a="b"}`), which
// the directive parser reads before MDX can.
const DIRECTIVE_ATTRIBUTES = /:+[a-z][\w-]*(?:\[[^\]\n]*\])?\{[^}\n]*\}/giu;
const ATX_HEADING = /^ {0,3}#{1,6}[\t ]/u;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[\t ]*$/u;

// An HTML void element not closed with `/>`. Attribute values may hold `/`
// and `>`, so quoted ones are skipped whole.
const VOID_ELEMENT = new RegExp(
  String.raw`${UNESCAPED}<(?<tag>area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)(?=[\s/>])(?:[^<>"'/]|"[^"]*"|'[^']*'|\/(?!>))*>`,
  "gu"
);

// The cheap tests that gate the scans both formats share.
const SUSPECT_WIKILINK = /\[\[/u;
const SUSPECT_MDC = /(?:^|[^\w:]):{1,2}[a-z][\w-]*[[{]|^[\t ]*::[a-z]/imu;

// An MDX comment, `{/* … */}`, which renders nothing.
const MDX_COMMENT = /\{\s*\/\*[\s\S]*?\*\/\s*\}/gu;

// A link or image destination in angle brackets, after `](` or a reference
// definition's `]:` (`![shot](<img/a b.png>)`, `[ref]: <br/x.png>`). Both
// formats read it as a URL, never as HTML, though it can open with a tag name.
const ANGLE_DESTINATION =
  /(?<=\]\([\t ]*|^ {0,3}\[[^\]\n]+\]:[\t ]*)<[^<>\n]*>/gmu;

// Inline code, or `.mdx` inline math: an unescaped run of two or more `$` (one
// is plain text) up to the next run of the same length. Whichever opens first
// holds the other as text, and neither reads `{…}` as an expression.
const INLINE_CODE_OR_MATH = new RegExp(
  String.raw`${INLINE_CODE.source}|${UNESCAPED}(?<!\$)(?<run>\${2,})(?!\$).*?(?<!\$)\k<run>(?!\$)`,
  "gu"
);

/** `text` with every character but line breaks turned into a space. */
const blank = (text: string): string => text.replaceAll(/[^\n]/gu, " ");

/**
 * An `.md` body with its code (fenced, indented, and inline) and HTML
 * comments blanked, exactly as the renderer's parser reads them.
 */
const maskMarkdown = (text: string): string => {
  const ranges: [number, number][] = [];
  const walk = (node: Nodes): void => {
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? start;
    if (
      node.type === "code" ||
      node.type === "inlineCode" ||
      (node.type === "html" && node.value.startsWith("<!--"))
    ) {
      ranges.push([start, end]);
    } else if ("children" in node) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  walk(
    markdownToMdast(text, {
      features: { ...MARKDOWN_BODY_FEATURES, gfm: true },
    })
  );
  let masked = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    masked += text.slice(cursor, start) + blank(text.slice(start, end));
    cursor = end;
  }
  return masked + text.slice(cursor);
};

/**
 * An `.mdx` body with code and math (fenced and inline), comments, and
 * angle-bracket link destinations blanked, line by line rather than parsed:
 * the problems this looks for are what keeps MDX from parsing a page. MDX has
 * no indented code blocks.
 */
const maskMdx = (text: string): string => {
  let fence: FenceState = null;
  return text
    .split("\n")
    .map((line) => {
      const next = nextFenceState(line, fence, true);
      const inFence = fence !== null || next !== null;
      fence = next;
      return inFence
        ? blank(line)
        : line.replaceAll(INLINE_CODE_OR_MATH, blank);
    })
    .join("\n")
    .replaceAll(MDX_COMMENT, blank)
    .replaceAll(HTML_COMMENT, blank)
    .replaceAll(ANGLE_DESTINATION, blank);
};

/** Where each line of `text` starts. */
const lineStartsOf = (text: string): number[] => {
  const starts = [0];
  for (
    let index = text.indexOf("\n");
    index !== -1;
    index = text.indexOf("\n", index + 1)
  ) {
    starts.push(index + 1);
  }
  return starts;
};

/** The 1-based line and column of offset `at`. */
const siteOf = (starts: readonly number[], at: number): Site => {
  const line = starts.findLastIndex((start) => start <= at);
  return { column: at - (starts[line] ?? 0) + 1, line: line + 1 };
};

const templateFindings = ({ starts, text }: Scan): Finding[] => [
  ...[...text.matchAll(TEMPLATE_TAG)].map((match) => ({
    ...siteOf(starts, match.index),
    code: "BLUME_TEMPLATE_TAG",
    message: `\`${match[0]}\` is a Liquid or Markdoc tag, which Blume doesn't run, so the page shows it as written.`,
    suggestion:
      "Rewrite what it produced as Markdown or a Blume component, or remove it. To show it as text, put it in inline code.",
  })),
  ...[...text.matchAll(TEMPLATE_OUTPUT)]
    .filter((match) => !VARIABLE_REFERENCE.test(match.groups?.expression ?? ""))
    .map((match) => ({
      ...siteOf(starts, match.index),
      code: "BLUME_TEMPLATE_TAG",
      message: `\`${match[0]}\` is a Liquid output tag, which Blume doesn't fill in, so the page shows it as written.`,
      suggestion:
        "Write the value in its place, or define it under `variables` in blume.config.ts and write `{{name}}`. To show it as text, put it in inline code.",
    })),
];

/**
 * A page name the way wiki links match it: GitHub wikis link `[[Getting
 * Started]]` to `Getting-Started.md`, and case doesn't count.
 */
const wikiKey = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_-]+/gu, "-");

/** Index pages by file name and title, for {@link syntaxDiagnostics}. */
export const indexPageNames = (pages: readonly PageRecord[]): PageNameIndex => {
  const index = new Map<string, PageRecord[]>();
  for (const page of pages) {
    const stem = (page.source.ref.split("/").at(-1) ?? "").replace(
      /\.mdx?$/iu,
      ""
    );
    for (const key of new Set([wikiKey(stem), wikiKey(page.title)])) {
      const named = index.get(key);
      if (named) {
        named.push(page);
      } else {
        index.set(key, [page]);
      }
    }
  }
  return index;
};

/** One side of a wiki link's `|`, and the route it names, if any. */
interface WikiPart {
  route?: string;
  text: string;
}

/** A wiki link side's route, with a `#heading` as the anchor it slugs to. */
const partRoute = (text: string, pageRoute: PageRoute): string | undefined => {
  const [name = "", heading] = text.split("#", 2);
  const route = pageRoute(name);
  return route && heading ? `${route}#${slug(heading)}` : route;
};

const wikilinkFindings = ({ pageRoute, starts, text }: Scan): Finding[] =>
  [...text.matchAll(WIKILINK)].flatMap((match) => {
    const parts: WikiPart[] = (match.groups?.inner ?? "")
      .split("|")
      .map((part) => ({
        route: partRoute(part, pageRoute),
        text: part.trim(),
      }));
    const target = parts.find((part) => part.route !== undefined);
    if (!target && parts.length === 1) {
      return [];
    }
    const label = parts.find((part) => part !== target) ?? target;
    return [
      {
        ...siteOf(starts, match.index),
        code: "BLUME_WIKILINK_UNSUPPORTED",
        message: `\`${match[0]}\` is a wiki link, which Blume reads only in an Obsidian vault source, so the page shows it as written${target ? ` instead of linking to ${target.route}` : ""}.`,
        suggestion: target
          ? `Rewrite it as a Markdown link: \`[${label?.text}](${target.route})\`.`
          : "Rewrite it as a Markdown link to the page, like `[Text](./page.md)`.",
      },
    ];
  });

const mdcFindings = ({ starts, text }: Scan): Finding[] => {
  const blocks = [...text.matchAll(MDC_BLOCK)].map((match) => ({
    at: match.index + match[0].indexOf("::"),
    written: match.groups?.written,
  }));
  const opened = new Set(blocks.map(({ at }) => at));
  return [
    ...blocks.map(({ at, written }) => ({
      ...siteOf(starts, at),
      code: "BLUME_MDC_SYNTAX",
      message: `\`${written}\` opens a Nuxt Content (MDC) block component, which Blume doesn't render, so the page shows its \`::\` lines as text.`,
      suggestion:
        "Rewrite the block as the matching Blume component (`<Callout>`, `<Card>`, `<Tabs>`, …) or a `:::` callout.",
    })),
    ...[...text.matchAll(MDC_INLINE)]
      .filter((match) => !opened.has(match.index))
      .map((match) => ({
        ...siteOf(starts, match.index),
        code: "BLUME_MDC_SYNTAX",
        message: `\`${match.groups?.written}\` is an inline component in Nuxt Content (MDC) syntax, which Blume doesn't render, so the page shows it as written.`,
        suggestion:
          "Rewrite it as the matching Blume component (`<Badge>`, `<Icon>`, …) or as plain text.",
      })),
  ];
};

/**
 * Whether the list at `column` of `line` is a heading's trailing `{#id}`
 * marker, which `BLUME_MDX_CURLY_ANCHOR` or `BLUME_MD_CURLY_ANCHOR` already
 * reports (an unspaced `{#id}` pins the anchor in `.md`). In `.mdx`, one that
 * also sets classes or attributes (`{#id .wide}`) is reported here instead.
 */
const isHeadingMarker = (
  lines: readonly string[],
  site: Site,
  written: string,
  format: "md" | "mdx"
): boolean => {
  const line = lines[site.line - 1] ?? "";
  const heading =
    ATX_HEADING.test(line) || SETEXT_UNDERLINE.test(lines[site.line] ?? "");
  const marker = trailingCurlyMarker(line);
  return (
    heading &&
    marker?.marker === written &&
    marker.index === site.column - 1 &&
    (format === "md" || !marker.attributes)
  );
};

/** What an attribute list does to a page in each format, and the way out. */
const ATTRIBUTE_LIST_PROBLEMS = {
  md: {
    code: "BLUME_MD_ATTRIBUTE_LIST",
    effect: "which Blume doesn't read, so the page shows it as written",
    suggestion:
      'Remove it. To keep the attributes, write the element as HTML (`<img src="…" width="300">`), or pin a heading\'s anchor with `[#id]`. To show the braces as text, put them in inline code.',
  },
  mdx: {
    code: "BLUME_MDX_ATTRIBUTE_LIST",
    effect:
      "which MDX reads as a JavaScript expression, so the page fails to build",
    suggestion:
      'Remove it. To keep the attributes, write the element as JSX (`<img src="…" width="300" />`), or pin a heading\'s anchor with `[#id]`. To show the braces as text, escape them: `\\{…\\}`.',
  },
} as const;

/**
 * The attribute lists in a body in `format`. A directive's own attributes and
 * a `{{ }}` variable or Liquid output aren't one.
 */
const attributeListFindings =
  (format: "md" | "mdx") =>
  ({ starts, text }: Scan): Finding[] => {
    const { code, effect, suggestion } = ATTRIBUTE_LIST_PROBLEMS[format];
    const scanned = text
      .replaceAll(DIRECTIVE_ATTRIBUTES, blank)
      .replaceAll(TEMPLATE_OUTPUT, blank);
    const lines = text.split("\n");
    return [...scanned.matchAll(ATTRIBUTE_LIST)]
      .map((match) => ({
        site: siteOf(starts, match.index),
        written: match[0],
      }))
      .filter(
        ({ site, written }) => !isHeadingMarker(lines, site, written, format)
      )
      .map(({ site, written }) => ({
        ...site,
        code,
        message: `\`${written}\` is an attribute list, ${effect}.`,
        suggestion,
      }));
  };

// An attribute list's opening brace and first attribute.
const SUSPECT_ATTRIBUTE_LIST = /\{:?[\t ]*(?:[#.][A-Za-z_-]|[\w-]+=)/u;

const voidElementFindings = ({ starts, text }: Scan): Finding[] =>
  [...text.matchAll(VOID_ELEMENT)]
    .filter(
      (match) =>
        !text
          .slice(match.index + match[0].length)
          .trimStart()
          .startsWith(`</${match.groups?.tag}>`)
    )
    .map((match) => ({
      ...siteOf(starts, match.index),
      code: "BLUME_MDX_UNCLOSED_ELEMENT",
      message: `\`<${match.groups?.tag}>\` isn't closed. MDX reads HTML as JSX, where it needs \`/>\`: unclosed, it fails the page, or in an included file it takes in everything after it.`,
      suggestion: `Close it: \`<${match.groups?.tag} … />\`.`,
    }));

/** A scan over masked text, and the cheap check that says it's worth running. */
interface Check {
  find: (scan: Scan) => Finding[];
  suspect: RegExp;
}

/** The checks each body format runs. */
const CHECKS: Record<"md" | "mdx", Check[]> = {
  md: [
    { find: templateFindings, suspect: /\{[%{]/u },
    { find: wikilinkFindings, suspect: SUSPECT_WIKILINK },
    { find: mdcFindings, suspect: SUSPECT_MDC },
    { find: attributeListFindings("md"), suspect: SUSPECT_ATTRIBUTE_LIST },
  ],
  mdx: [
    { find: wikilinkFindings, suspect: SUSPECT_WIKILINK },
    { find: mdcFindings, suspect: SUSPECT_MDC },
    { find: attributeListFindings("mdx"), suspect: SUSPECT_ATTRIBUTE_LIST },
    {
      find: voidElementFindings,
      suspect:
        /<(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)[\s/>]/u,
    },
  ],
};

/**
 * Every finding in `text`, a body in `format`, in source order. The body is
 * masked only when a check's cheap test matches, so most pages cost a few
 * regex tests.
 */
const syntaxFindings = (
  text: string,
  format: "md" | "mdx",
  pageRoute: PageRoute
): Finding[] => {
  const checks = CHECKS[format].filter((check) => check.suspect.test(text));
  if (checks.length === 0) {
    return [];
  }
  const masked = format === "mdx" ? maskMdx(text) : maskMarkdown(text);
  const scan = { pageRoute, starts: lineStartsOf(masked), text: masked };
  return checks
    .flatMap((check) => check.find(scan))
    .toSorted((a, b) => a.line - b.line || a.column - b.column);
};

/**
 * Warn about syntax from other docs tools in an entry's body (see the module
 * comment). `pages` are the site's pages by name, which a wiki link resolves
 * against, preferring one in the entry's own `locale`. Lines point into the
 * file the author wrote, a partial's own file for syntax an `<include>`
 * brought in.
 */
export const syntaxDiagnostics = (
  entry: SourceEntry,
  sourceName: string,
  pages: PageNameIndex = new Map(),
  locale = ""
): Diagnostic[] => {
  const page = entry.sourcePath ?? `${sourceName}:${entry.ref}`;
  const offset =
    entry.bodyLineOffset ?? strippedLineOffset(entry.raw, entry.body.text);
  const pageRoute = (name: string): string | undefined => {
    const named = pages.get(wikiKey(name));
    return (named?.find((other) => other.locale === locale) ?? named?.[0])
      ?.route;
  };
  return syntaxFindings(
    entry.expanded?.text ?? entry.body.text,
    entry.body.format,
    pageRoute
  ).map(({ line, ...finding }) => {
    const origin = entry.expanded?.origins[line - 1];
    return {
      ...finding,
      file: origin?.file ?? page,
      line: origin?.line ?? line + offset,
      severity: "warning",
    };
  });
};

import { existsSync, readFileSync } from "node:fs";

import GithubSlugger from "github-slugger";
import type { Nodes } from "mdast";
import { extname } from "pathe";
import { markdownToMdast } from "satteri";

import { MARKDOWN_FEATURES } from "../../markdown/features.ts";
import { mountBasePath } from "../base-path.ts";
import { nextFenceState } from "../code-fences.ts";
import type { FenceState } from "../code-fences.ts";
import { diagnosticsFromIssues, diagnosticsFromZod } from "../diagnostics.ts";
import { occupySlug, parseHeadingMarkers } from "../heading-markers.ts";
import { localePlacement, localizeRoute } from "../i18n.ts";
import { titleWord } from "../navigation.ts";
import { stripOrderingPrefix } from "../ordering-prefix.ts";
import { pageMetaSchema } from "../schema.ts";
import type {
  FrontmatterExtend,
  PageMeta,
  ResolvedI18nConfig,
} from "../schema.ts";
import { trimChar } from "../trim.ts";
import type { Diagnostic, Heading, PageLink, PageRecord } from "../types.ts";
import { detectVersionRef, versionizeRoute } from "../versions.ts";
import type { NormalizeContext, SourceEntry } from "./types.ts";

const GROUP_FOLDER = /^\((?<label>.+)\)$/u;
const WORD_SPLIT = /[-_]/u;

/** Strip a leading numeric ordering prefix (`01-intro` -> `intro`). */
const stripNumericPrefix = (segment: string): string =>
  stripOrderingPrefix(segment);

/** Detect a group folder `(name)` and return its label, else null. */
const groupLabel = (segment: string): string | null =>
  segment.match(GROUP_FOLDER)?.groups?.label ?? null;

/**
 * {@link groupLabel} for a file or folder name, which may carry its ordering
 * prefix outside the parentheses: `01-(guides)` is the `guides` group, sorted
 * first, the way `01-guides` is the `guides` folder.
 */
const orderedGroupLabel = (segment: string): string | null =>
  groupLabel(segment) ?? groupLabel(stripNumericPrefix(segment));

/**
 * Slugify a content/route slug (Sanity, Notion, frontmatter `slug`). Heading
 * anchor ids are *not* slugged here — they use a `github-slugger` in
 * {@link extractHeadings}, matching the renderer (see `markdown/heading-anchors`)
 * so `blume validate` checks anchors against the exact rendered heading ids.
 *
 * The keep-class is Unicode letters/marks/numbers, not `\w`: ASCII slugs are
 * unchanged, but a CJK/Cyrillic/accented slug keeps its characters instead of
 * collapsing to `""` (which forced Sanity/Notion routes onto their opaque
 * document-id fallbacks) or dropping accents (`café` → `caf`). NFC first so a
 * macOS-NFD `é` (e + combining mark) slugs identically to the composed form.
 */
export const slugify = (text: string): string =>
  text
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replaceAll(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replaceAll(/[\s_]+/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replaceAll(/^-|-$/gu, "");

/**
 * {@link slugify} for a slug that may span path segments (`guides/setup`).
 * `slugify` deletes `/` along with all other punctuation, which would mash
 * `guides/setup` into `guidessetup` — and collide it with a genuine `guidessetup`
 * document. Each segment is slugged on its own and the separators kept.
 */
export const slugifyPath = (text: string): string =>
  text.split("/").map(slugify).filter(Boolean).join("/");

/** Title-case a slug segment for display, acronyms as the sidebar spells them. */
const titleCase = (value: string): string =>
  value.split(WORD_SPLIT).filter(Boolean).map(titleWord).join(" ");

/**
 * Strip characters that cannot survive the route → URL → output-file round
 * trip. A `:` ahead of the first `/` makes `new URL()` read the segment as a
 * scheme (`Guide: Architecture.md` → `guide:`), which crashes Astro's
 * prerender write with "The URL must be of scheme file"; control characters
 * (an embedded newline in a filename) are silently dropped by the URL parser,
 * desyncing the route from its output path. `#` and `?` start a URL's
 * fragment and query, so an unescaped `/sdks/c#` link lands on `/sdks/c`
 * while Astro writes the page to `c%23/`; a `%` starts an escape, and a bare
 * one is an invalid URL Astro can't decode (and one it escapes, `%25`, finds
 * no static path). All are legal in macOS/Linux filenames, so they are
 * removed here rather than rejected: `100%.md` publishes at `/100`, and a
 * slug of `sdks/c#` at `/sdks/c`. A file whose own path holds `#` or `?`
 * never gets this far — Astro can't load it (see
 * {@link unloadablePathDiagnostic}).
 */
const sanitizeSegment = (segment: string): string =>
  segment.replaceAll(/[:#?%\p{Cc}]/gu, "");

// Astro's content loader reads each entry at `new URL("./" + encodeURI(entry),
// base)`. `encodeURI` escapes `%` but leaves `#` and `?` alone, so in a path
// they start the URL's fragment and query, and the read misses the file.
const UNLOADABLE_PATH = /[#?]/u;

/**
 * The error for a content file Astro's content loader can't read, or
 * undefined when it can. A `#` or `?` anywhere in the path the loader is
 * handed (`sdks/c#.md`, `faq/why?.md`) truncates the file URL it reads
 * through, so the read fails with ENOENT and the page renders "Page not
 * found" at its route. A source leaves such a file out of its scan and
 * reports this instead of publishing a route that can never render.
 */
export const unloadablePathDiagnostic = (
  path: string,
  file: string
): Diagnostic | undefined =>
  UNLOADABLE_PATH.test(path)
    ? {
        code: "BLUME_UNLOADABLE_FILE_NAME",
        file,
        message: `"${path}" has a "#" or "?" in its path, which Astro's content loader reads as the start of a URL fragment or query, so it can't load the file. It was left out of the site.`,
        severity: "error",
        suggestion:
          'Rename the file (or its folder) without "#" or "?". Both are dropped from the page\'s URL anyway, so the page keeps its route.',
      }
    : undefined;

/**
 * Fold one raw path part into the accumulating route segments/groups.
 * `ordered` parts are file or folder names, whose ordering prefix is dropped.
 */
const addRouteSegment = (
  part: string,
  segments: string[],
  groups: string[],
  ordered: boolean
): void => {
  // A leading/trailing/double slash yields an empty part; keeping it would
  // produce a malformed route (`//foo`, `/foo/`) that nothing can link to.
  if (part === "") {
    return;
  }
  const group = ordered ? orderedGroupLabel(part) : groupLabel(part);
  if (group !== null) {
    groups.push(group);
    return;
  }
  const clean = ordered ? stripNumericPrefix(part) : part;
  if (clean === "index") {
    return;
  }
  const safe = sanitizeSegment(clean);
  // A part that was nothing but stripped characters cannot name a segment.
  if (safe === "") {
    return;
  }
  segments.push(safe);
};

/** URL + nav metadata mapped from one content-root-relative path. */
interface MappedRoute {
  segments: string[];
  groups: string[];
  route: string;
}

/**
 * Convert a source's route prefix and a content-root-relative path into URL +
 * nav metadata. Only the path's parts lose an ordering prefix, and only when
 * `ordered` says they are file and folder names: the route prefix, a slug,
 * a release tag, or a CMS slug is a route spelled out, kept as written. Not
 * exported: a source that needs to predict a route goes through
 * {@link resolveEntryRoute}, so there is exactly one derivation.
 */
const mapRoute = (
  prefix: string | undefined,
  relativePath: string,
  ordered: boolean
): MappedRoute => {
  const withoutExt = relativePath.slice(
    0,
    relativePath.length - extname(relativePath).length
  );

  const segments: string[] = [];
  const groups: string[] = [];

  for (const part of prefix ? prefix.split("/") : []) {
    addRouteSegment(part, segments, groups, false);
  }
  for (const part of withoutExt.split("/")) {
    addRouteSegment(part, segments, groups, ordered);
  }

  const route = segments.length === 0 ? "/" : `/${segments.join("/")}`;
  return { groups, route, segments };
};

// A closing hash sequence must be preceded by whitespace (CommonMark), so a
// heading like `## What is C#` keeps its trailing `#`. Up to 3 leading spaces
// are allowed; 4+ is an indented code block.
const ATX_HEADING = /^ {0,3}(?<hashes>#{1,6})\s+(?<text>.+?)(?:\s+#+)?\s*$/u;
// A setext underline: a run of `=` (level 1) or `-` (level 2) alone on a line,
// up to 3 leading spaces. It only forms a heading directly under paragraph
// text — see `scanHeadingLine`.
const SETEXT_UNDERLINE = /^ {0,3}(?<marker>=+|-+)\s*$/u;
// Lines that end a paragraph without being one (CommonMark): blank lines are
// checked separately; these cover list items, blockquotes, and thematic
// breaks, so a `---` after any of them stays a thematic break, not an
// underline promoting the list/quote text to a heading.
const PARAGRAPH_INTERRUPT = /^ {0,3}(?:[-+*][ \t]|\d{1,9}[.)][ \t]|>)/u;
const THEMATIC_BREAK =
  /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/u;
// `<Prompt>` renders its children into a permanently `hidden` DOM node (see
// `Prompt.astro`) — the agent-facing prompt text is never visible page
// content, only read by client JS for the copy button. Any `##` inside it
// must not surface in the page's heading-derived table of contents. Tracked
// as an open/close depth, the same way fenced code blocks are tracked above.
// The opening tag is matched only at the start of a trimmed line: block-level
// JSX in MDX starts its own line, so a mention mid-prose or mid-heading —
// "the `<Prompt>` component", `## Using <Prompt>` — never opens a hidden
// region (an unanchored match here silently ate every heading after the
// mention). The lookahead rejects longer tag names that share the prefix,
// like `<PromptCard>` or `<Prompt-Custom>`.
const PROMPT_OPEN = /^<Prompt(?![\w-])/u;
// Unanchored: while inside a prompt the close tag may trail the hidden
// children text (`...copy this.</Prompt>`), not just sit on its own line.
const PROMPT_CLOSE = /<\/Prompt>/u;

// A trailing `{#id}` heading marker written without a backslash escape. Both
// pipelines resolve escapes before parsing markers (the scan parses each
// heading with the renderer's grammar — see `renderHeading`), so `\{#id\}` is
// the same marker — and the only spelling that survives the MDX parser, where
// a bare `{…}` is a JSX expression and `#id` is not a valid one (`Could not
// parse expression with acorn`). Further bracket markers may follow the brace
// (`{#id} [toc]`), nothing else.
const BARE_CURLY_MARKER =
  /(?<!\\)\{#(?<id>[^\s}]+)\}(?:\s*\[(?:#[^\s\]]+|!?toc)\])*\s*$/u;

// A raw HTML element carrying an `id` — `<a id="…">`, `<section id='…'>`,
// the unquoted `<a id=plain>`, or the JSX spelling `<div id={"…"}>` — whose
// element is a fragment-link target outside headings. Lowercase tags only: a
// capitalized `<YouTube id="…">` is a component prop, not a DOM id (the
// `JSX_OPEN` split below). `[^<>]` bounds the attribute run, so a wrapped tag
// (`<div\n  id="x"\n>`) still matches while a long tag-free line can't
// backtrack quadratically, and the run never reaches into a neighboring tag.
const HTML_ID =
  /<[a-z][a-z0-9-]*(?:\s[^<>]*?)?\sid=(?:(?<quote>["'])(?<quoted>[^"'<>]+)\k<quote>|\{(?<jsxQuote>["'])(?<jsx>[^"'<>]+)\k<jsxQuote>\}|(?<bare>[^\s"'=<>`{}]+))/gu;
// Commented-out markup renders nothing; matched across lines once the
// scannable lines are joined back together. Shared with the search
// extractor so both agree on what a comment is.
export const HTML_COMMENT = /<!--[\s\S]*?-->/gu;
export const INLINE_CODE = /`[^`]*`/gu;

/** A heading whose trailing `{#id}` marker is unescaped — see `BARE_CURLY_MARKER`. */
export interface CurlyMarker {
  id: string;
  /** 1-based line of the heading (a setext heading's first text line) in the body. */
  line: number;
}

/** Scanner state: the open fence plus the paragraph lines accumulated so far. */
interface HeadingScanState {
  /**
   * Lines eligible to hold an HTML `id` — outside fences and `<Prompt>`
   * regions, inline code masked — collected for one `HTML_ID` pass at the
   * end so a tag wrapped over several lines still matches.
   */
  anchorLines: string[];
  /** The multi-line comment the scan is inside, if any — see `scanCommentLine`. */
  comment: "html" | "jsx" | null;
  curlyMarkers: CurlyMarker[];
  fence: FenceState;
  /** 1-based body line of the line being scanned. */
  line: number;
  /** Where each heading in `headings` sits, index-aligned. */
  sites: HeadingSite[];
  /** Consecutive paragraph lines — the candidate text for a setext underline. */
  paragraph: string[];
  /** Body line of the first line in `paragraph`. */
  paragraphStart: number;
  /** Nesting depth inside `<Prompt>...</Prompt>` — 0 when outside one. */
  promptDepth: number;
  /** True inside a multi-line `<Prompt` opening tag, awaiting its `>`. */
  promptTag: boolean;
}

/**
 * Consume the rest of a `<Prompt` opening tag, scanning a trimmed line from
 * `start`. The tag's attributes may spread over several lines
 * (`state.promptTag` carries the search onto the next one), and until the
 * terminating `>` arrives it isn't known whether the tag even has children —
 * so the depth only rises once that `>` is found, and not when it turns out
 * to be `/>` or when the element also closes on the same line
 * (`<Prompt ...>copy this</Prompt>`). Attribute values containing `>` are not
 * parsed: the first `>` ends the tag, which errs toward opening a region a
 * real close tag will still exit.
 */
const finishPromptTag = (
  line: string,
  start: number,
  state: HeadingScanState
): void => {
  const end = line.indexOf(">", start);
  if (end === -1) {
    state.promptTag = true;
    return;
  }
  state.promptTag = false;
  if (line[end - 1] === "/" || line.includes("</Prompt>", end)) {
    return;
  }
  state.promptDepth += 1;
};

/**
 * Extract ATX and setext headings from a markdown body, skipping fenced code
 * blocks and `<Prompt>` children, exactly as the renderer sees them: ATX
 * headings may be indented up to 3 spaces, and a paragraph underlined with
 * `=`/`-` is a level 1/2 setext heading. Each heading's anchor slug comes
 * from a per-document
 * `github-slugger` — the exact slugger the renderer uses
 * (`markdown/heading-anchors`) — advanced over every heading in document
 * order. Matching it (rather than a hand-rolled slugify) keeps the manifest's
 * anchor ids identical to the rendered ones, so `blume validate` stops
 * false-flagging links like `#the-read--write-fallback` (a hand slugify
 * collapses `--`; github-slugger keeps it) and resolves repeated headings the
 * same way (`setup`, `setup-1`).
 */
// A heading's inline Markdown is parsed with the renderer's own grammar:
// Blume's `.md` feature set plus the Astro defaults Blume never turns off, GFM
// and smart punctuation (Astro's `smartypants`). Front matter is off — the
// source is a lone heading. The display text is read without smart
// punctuation (see `toHeading`).
const HEADING_FEATURES = {
  ...MARKDOWN_FEATURES,
  frontmatter: false,
  gfm: true,
};
const HEADING_PARSE = {
  features: { ...HEADING_FEATURES, smartPunctuation: true },
};
const HEADING_TEXT_PARSE = {
  features: { ...HEADING_FEATURES, smartPunctuation: false },
};

// Characters that can make a heading's rendered text differ from its source:
// escapes, code spans, emphasis/strikethrough/sub/superscript markers, link and
// image brackets, raw HTML and autolinks, entities, and the quotes, dashes, and
// ellipses smart punctuation rewrites. A heading with none of them renders as
// written, so it skips the parse.
const INLINE_MARKUP = /[\\`*_~^[\]<&'"]|--|\.\.\./u;
// The subset smart punctuation rewrites (`"a"` → `“a”`, `--` → `–`, `...` → `…`).
const SMART_PUNCTUATION = /['"]|--|\.\.\./u;

// The start of a link-reference definition, as the renderer accepts it:
// `[label]:` after up to 3 leading spaces, optionally inside block-quote or
// list-item containers (`> [label]: /url`, `- [label]: /url`) — a definition
// nested in either still defines the label document-wide. `rest` is whatever
// follows the colon on the same line.
//
// Every container iteration begins with its marker and ends with the
// whitespace that follows it, so a whitespace run belongs to exactly one
// iteration. Letting an iteration start with optional whitespace as well
// gave each run two homes and backtracked exponentially on `>\t>\t>…` and
// `*\t\t*\t\t*…` lines (CodeQL js/redos).
const REF_DEFINITION =
  /^(?: {0,3}|[ \t]*(?:(?:>|(?:[-*+]|\d{1,9}[.)])[ \t])[ \t]*)+)\[(?<label>[^\]]+)\]:[ \t]*(?<rest>.*)$/u;

/**
 * The normalized labels of every link-reference definition in the body
 * (outside fenced code), footnote definitions (`^1`) included. A heading
 * bracket whose label is defined is a CommonMark reference link —
 * `[text][label]`, or a shortcut `[label]` that would otherwise read as a
 * trailing `[toc]`/`[#id]` marker — or a GFM footnote reference, so each
 * heading is parsed together with the definitions it names (see
 * {@link definitionsFor}). Labels match case-insensitively with collapsed
 * internal whitespace (CommonMark).
 *
 * Only a *valid* definition defines a label: the label must contain a
 * non-whitespace character, and a destination must follow — on the same line
 * or, as CommonMark allows, alone on the next. A bare `[toc]:` with nothing
 * after it is paragraph text, and the renderer still treats the heading's
 * `[toc]` as literal — which Blume reads as a marker — so it must not be
 * recorded here.
 */
const refDefinitionLabels = (lines: readonly string[]): Set<string> => {
  const labels = new Set<string>();
  let fence: FenceState = null;
  for (const [index, line] of lines.entries()) {
    const next = nextFenceState(line, fence);
    if (fence !== null || next !== null) {
      fence = next;
      continue;
    }
    const groups = line.match(REF_DEFINITION)?.groups;
    if (groups?.label === undefined || groups.label.trim() === "") {
      continue;
    }
    const destination = groups.rest ?? "";
    if (destination === "" && (lines[index + 1] ?? "").trim() === "") {
      continue;
    }
    labels.add(groups.label.trim().replaceAll(/\s+/gu, " ").toLowerCase());
  }
  return labels;
};

/**
 * The link-reference and footnote definitions a heading's brackets may name,
 * as source lines to parse the heading with. A definition the heading doesn't
 * use changes nothing, so matching is loose (the label anywhere in the folded
 * text). A footnote label (`^1`) is defined too, so `[^1]` parses as the
 * footnote reference it renders as, not as literal text.
 */
const definitionsFor = (raw: string, labels: ReadonlySet<string>): string => {
  if (!raw.includes("[")) {
    return "";
  }
  const folded = raw.replaceAll(/\s+/gu, " ").toLowerCase();
  let definitions = "";
  for (const label of labels) {
    if (folded.includes(label)) {
      definitions += `\n\n[${label}]: /`;
    }
  }
  return definitions;
};

/**
 * The number each footnote renders as, keyed by identifier. GFM numbers
 * footnotes in the order the body first references them, whatever order their
 * definitions sit in, so a `[^b]` cited before `[^a]` renders as 1. A
 * reference inside a footnote definition is left out: the renderer reaches
 * those only after the body.
 */
const footnoteNumbers = (body: string): Map<string, number> => {
  const numbers = new Map<string, number>();
  const visit = (nodes: readonly Nodes[]): void => {
    for (const node of nodes) {
      if (node.type === "footnoteReference") {
        if (!numbers.has(node.identifier)) {
          numbers.set(node.identifier, numbers.size + 1);
        }
      } else if (node.type !== "footnoteDefinition" && "children" in node) {
        visit(node.children);
      }
    }
  };
  const tree = markdownToMdast(body, HEADING_PARSE);
  visit("children" in tree ? tree.children : []);
  return numbers;
};

/** What reading one heading needs from the rest of its body. */
interface HeadingContext {
  /**
   * The number each footnote renders as (see {@link footnoteNumbers}),
   * computed on first use: only a heading that cites a footnote needs it.
   */
  footnotes: () => ReadonlyMap<string, number>;
  /** The body's link-reference and footnote definition labels. */
  labels: ReadonlySet<string>;
}

/**
 * The text content of mdast inline nodes, the way the rendered heading reads
 * it: link and emphasis text, code-span contents, decoded entities, and a
 * footnote reference's number. Raw HTML tags add no text (the text between
 * them is its own node), and an image's alt is an attribute rather than text
 * content.
 */
const inlineText = (nodes: readonly Nodes[], context: HeadingContext): string =>
  nodes
    .map((node) => {
      if (
        node.type === "html" ||
        node.type === "image" ||
        node.type === "imageReference"
      ) {
        return "";
      }
      if (node.type === "break") {
        return "\n";
      }
      if (node.type === "footnoteReference") {
        // A reference the body's own parse never numbered (a heading the scan
        // finds inside an HTML block) is no footnote to the renderer either.
        const number = context.footnotes().get(node.identifier);
        return number === undefined
          ? `[^${node.label ?? node.identifier}]`
          : String(number);
      }
      if ("children" in node) {
        return inlineText(node.children, context);
      }
      return "value" in node ? node.value : "";
    })
    .join("");

/** A heading's rendered text plus the trailing markers the renderer strips. */
interface RenderedHeading {
  /** Author-pinned anchor id from `[#id]`/`{#id}`, used verbatim. */
  id?: string;
  /** The text content the renderer slugs, markers stripped, untrimmed. */
  text: string;
  toc?: "hide" | "only";
}

/** A heading whose source is its text: one text node, markers stripped. */
const plainHeading = (raw: string): RenderedHeading => {
  const markers = parseHeadingMarkers(raw);
  // A heading that is nothing but markers keeps them as literal text.
  return markers.text === ""
    ? { text: raw }
    : { id: markers.id, text: markers.text, toc: markers.toc };
};

/**
 * Parse a heading's inline Markdown and read it the way
 * `markdown/heading-anchors` does: the heading's text content, with trailing
 * markers stripped from its last node only when that node is text (a heading
 * ending in inline code or a link has no marker position) and some heading
 * text remains. Parsing (rather than regex-stripping) resolves escapes —
 * `\[toc]` still reaches the marker parse as `[toc]` — and emphasis the way
 * CommonMark does, so `snake_case` stays whole while `_note_` loses its
 * underscores.
 */
const renderHeading = (
  raw: string,
  form: "atx" | "setext",
  context: HeadingContext,
  parse: typeof HEADING_PARSE
): RenderedHeading => {
  if (!INLINE_MARKUP.test(raw)) {
    return plainHeading(raw);
  }
  const source = form === "atx" ? `# ${raw}` : `${raw}\n=`;
  const tree = markdownToMdast(
    `${source}${definitionsFor(raw, context.labels)}`,
    parse
  );
  const heading = "children" in tree ? tree.children.at(0) : undefined;
  // The scan's paragraph tracking is coarser than the parser's: underlined
  // text that opens with an HTML block or a definition is no heading to the
  // renderer. It is read as written.
  if (heading?.type !== "heading") {
    return plainHeading(raw);
  }
  const { children } = heading;
  const text = inlineText(children, context);
  const last = children.at(-1);
  if (last?.type !== "text") {
    return { text };
  }
  const markers = parseHeadingMarkers(last.value);
  const stripped = last.value.length - markers.text.length;
  if (stripped === 0 || (markers.text === "" && children.length === 1)) {
    return { text };
  }
  return {
    id: markers.id,
    text: text.slice(0, text.length - stripped),
    toc: markers.toc,
  };
};

/**
 * A heading record from raw heading text, read exactly as the renderer reads
 * it: inline Markdown reduced to its rendered text (see {@link renderHeading})
 * and trailing markers stripped. The slug is the renderer's slug of that text.
 * A `[#custom-id]` pin becomes the slug verbatim and — matching the renderer —
 * occupies its id in the slugger, so a later heading whose auto-slug collides
 * disambiguates (`setup` → `setup-1`). `[!toc]`/`[toc]` headings stay in the
 * record: their ids exist in the rendered page, so links to them are valid
 * anchors regardless of TOC visibility.
 *
 * The record's `text` — a page's fallback title and sidebar label — is the
 * same rendered text with whitespace collapsed, but read without smart
 * punctuation: it keeps the straight quotes and double hyphens the author
 * typed, the way a frontmatter `title` does, and the way an Obsidian
 * `[[Note#It's here]]` heading link spells the heading it resolves against.
 */
/** A scanned heading plus whether its id came from an author pin. */
interface ScannedHeading {
  heading: Heading;
  pinned: boolean;
}

const toHeading = (
  depth: number,
  raw: string,
  form: "atx" | "setext",
  slugger: GithubSlugger,
  context: HeadingContext
): ScannedHeading => {
  const rendered = renderHeading(raw, form, context, HEADING_PARSE);
  const display = SMART_PUNCTUATION.test(raw)
    ? renderHeading(raw, form, context, HEADING_TEXT_PARSE).text
    : rendered.text;
  const text = display.replaceAll(/[\t\n\f\r ]+/gu, " ").trim();
  if (rendered.id !== undefined) {
    occupySlug(slugger, rendered.id);
    return { heading: { depth, slug: rendered.id, text }, pinned: true };
  }
  return {
    heading: { depth, slug: slugger.slug(rendered.text), text },
    pinned: false,
  };
};

/** Record a heading and where a trailing marker would be written for it. */
const pushHeading = (
  headings: Heading[],
  state: HeadingScanState,
  scanned: ScannedHeading,
  line: number
): void => {
  headings.push(scanned.heading);
  state.sites.push({ line, pinned: scanned.pinned });
};

/** Record a heading's unescaped trailing `{#id}` so `.mdx` pages can be warned. */
const noteCurlyMarker = (
  text: string,
  line: number,
  state: HeadingScanState
): void => {
  const id = text.match(BARE_CURLY_MARKER)?.groups?.id;
  if (id !== undefined) {
    state.curlyMarkers.push({ id, line });
  }
};

/** Scan a line outside fences and prompts: an anchor host, a heading, or prose. */
const scanContentLine = (
  line: string,
  state: HeadingScanState,
  slugger: GithubSlugger,
  headings: Heading[],
  context: HeadingContext
): void => {
  // Inline code is masked so a documented `<a id="…">` isn't an anchor.
  state.anchorLines.push(line.replaceAll(INLINE_CODE, ""));
  const atx = line.match(ATX_HEADING);
  if (atx?.groups) {
    const depth = atx.groups.hashes?.length ?? 1;
    const text = (atx.groups.text ?? "").trim();
    pushHeading(
      headings,
      state,
      toHeading(depth, text, "atx", slugger, context),
      state.line
    );
    noteCurlyMarker(text, state.line, state);
    state.paragraph = [];
    return;
  }
  const setext = line.match(SETEXT_UNDERLINE);
  if (setext?.groups && state.paragraph.length > 0) {
    // Setext wins over thematic break when it closes a paragraph (CommonMark);
    // a multi-line paragraph renders as one heading. Its lines keep their line
    // breaks, which the rendered text content keeps too (and the slugger
    // drops, so `Multi\nline` anchors as `multiline`).
    const depth = setext.groups.marker?.startsWith("=") ? 1 : 2;
    const text = state.paragraph.join("\n");
    // A setext heading's markers trail its last text line, just above the
    // underline — that is where a pin is appended.
    pushHeading(
      headings,
      state,
      toHeading(depth, text, "setext", slugger, context),
      state.line - 1
    );
    noteCurlyMarker(text, state.paragraphStart, state);
    state.paragraph = [];
    return;
  }
  if (
    line.trim() === "" ||
    THEMATIC_BREAK.test(line) ||
    PARAGRAPH_INTERRUPT.test(line)
  ) {
    state.paragraph = [];
    return;
  }
  if (state.paragraph.length === 0) {
    state.paragraphStart = state.line;
  }
  state.paragraph.push(line.trim());
};

// A comment that opens a line hides everything up to its close from the
// reader: an HTML comment (`<!--` … `-->`, a CommonMark HTML block, so up to
// 3 leading spaces) or an MDX JSX one (`{/*` … `*/}`, any indentation — MDX
// has no indented code).
const HTML_COMMENT_OPEN = /^ {0,3}<!--/u;
const JSX_COMMENT_OPEN = /^\s*\{\/\*/u;
const JSX_COMMENT_CLOSE = /\*\/\s*\}/u;

/**
 * Advance the multi-line comment state over one line, returning whether the
 * line belongs to a comment. A commented-out `# Old title` renders nothing, so
 * it must not become a heading — the page title, a TOC entry, or an anchor.
 * A comment that closes on its opening line is left to the regular scan,
 * which never reads a line starting with `<` or `{` as a heading. The
 * CommonMark end condition is any `-->` on the line, the opening one
 * included.
 */
const scanCommentLine = (line: string, state: HeadingScanState): boolean => {
  if (state.comment === "html") {
    if (line.includes("-->")) {
      state.comment = null;
    }
    return true;
  }
  if (state.comment === "jsx") {
    if (JSX_COMMENT_CLOSE.test(line)) {
      state.comment = null;
    }
    return true;
  }
  if (HTML_COMMENT_OPEN.test(line) && !line.includes("-->")) {
    state.comment = "html";
    return true;
  }
  const jsx = JSX_COMMENT_OPEN.exec(line);
  if (jsx && !JSX_COMMENT_CLOSE.test(line.slice(jsx[0].length))) {
    state.comment = "jsx";
    return true;
  }
  return false;
};

/** Scan one line for a heading, advancing the fence/paragraph state. */
const scanHeadingLine = (
  line: string,
  state: HeadingScanState,
  slugger: GithubSlugger,
  headings: Heading[],
  context: HeadingContext
): void => {
  // Comments hide fences too, and fences and prompts hide comments. A comment
  // line still goes to the anchor pass, which strips HTML comments itself.
  if (
    state.fence === null &&
    state.promptDepth === 0 &&
    !state.promptTag &&
    scanCommentLine(line, state)
  ) {
    state.anchorLines.push(line.replaceAll(INLINE_CODE, ""));
    state.paragraph = [];
    return;
  }
  const next = nextFenceState(line, state.fence);
  // Skip fence delimiter lines themselves and anything inside a fence. A fence
  // also ends any open paragraph, so no underline can reach across it.
  if (state.fence !== null || next !== null) {
    state.fence = next;
    state.paragraph = [];
    return;
  }
  // Prompt tags may be indented arbitrarily (MDX has no indented code
  // blocks), so they match against the trimmed line. A tag line can't also
  // be a heading, so each just updates the state and moves on, same as a
  // fence delimiter line. Outside a prompt, a `</Prompt>` line is plain text.
  const trimmed = line.trimStart();
  if (state.promptTag) {
    finishPromptTag(trimmed, 0, state);
    state.paragraph = [];
    return;
  }
  if (PROMPT_OPEN.test(trimmed)) {
    finishPromptTag(trimmed, "<Prompt".length, state);
    state.paragraph = [];
    return;
  }
  if (state.promptDepth > 0) {
    if (PROMPT_CLOSE.test(line)) {
      state.promptDepth -= 1;
    }
    state.paragraph = [];
    return;
  }
  scanContentLine(line, state, slugger, headings, context);
};

/** Where a heading's text ends in the scanned text, for appending a marker. */
export interface HeadingSite {
  /** 1-based line (of the text passed to `scanBody`) that any trailing marker ends. */
  line: number;
  /** True when the heading already pins its id with `[#id]`/`{#id}`. */
  pinned: boolean;
}

/** Everything one walk over a body yields for the anchor index. */
export interface BodyScan {
  /**
   * Raw HTML element ids (`<a id="…">`) outside headings, fences, inline
   * code, comments, and `<Prompt>` regions — fragment-link targets that
   * `blume validate` accepts alongside heading slugs. Deduplicated, in
   * document order.
   */
  anchors: string[];
  /** Headings whose trailing `{#id}` marker is unescaped, for `.mdx` pages. */
  curlyMarkers: CurlyMarker[];
  headings: Heading[];
  /** Index-aligned with `headings`: where each one's markers would go. */
  sites: HeadingSite[];
}

/**
 * Scan a body for its headings, explicit HTML anchors, and unescaped `{#id}`
 * markers in one fence-aware walk (the same walk `extractHeadings` exposes for
 * headings alone). The body is the page's content with its front matter
 * already stripped — the renderers read front matter off the page and never
 * again from its body — so a leading `---` block is a thematic break and
 * content, in `.md` and `.mdx` alike.
 */
export const scanBody = (body: string): BodyScan => {
  const headings: Heading[] = [];
  const slugger = new GithubSlugger();
  const state: HeadingScanState = {
    anchorLines: [],
    comment: null,
    curlyMarkers: [],
    fence: null,
    line: 0,
    paragraph: [],
    paragraphStart: 0,
    promptDepth: 0,
    promptTag: false,
    sites: [],
  };

  const lines = body.split("\n");
  let footnotes: Map<string, number> | undefined;
  const context: HeadingContext = {
    footnotes: () => {
      footnotes ??= footnoteNumbers(lines.join("\n"));
      return footnotes;
    },
    labels: refDefinitionLabels(lines),
  };
  for (const [index, line] of lines.entries()) {
    state.line = index + 1;
    scanHeadingLine(line, state, slugger, headings, context);
  }

  const anchors = new Set<string>();
  // Replaced with a space rather than removed: dropping a comment outright
  // can splice its neighbors into a new `<!--` (`<!-<!-- x -->->`), and a
  // space keeps a tag from fusing with an `id=` that only a comment separated.
  const markup = state.anchorLines.join("\n").replaceAll(HTML_COMMENT, " ");
  for (const match of markup.matchAll(HTML_ID)) {
    const id = match.groups?.quoted ?? match.groups?.jsx ?? match.groups?.bare;
    if (id !== undefined) {
      anchors.add(id);
    }
  }
  return {
    anchors: [...anchors],
    curlyMarkers: state.curlyMarkers,
    headings,
    sites: state.sites,
  };
};

export const extractHeadings = (body: string): Heading[] =>
  scanBody(body).headings;

// The label admits one level of nested brackets so an image-wrapped link
// (`[![alt](/img.png)](/target)`) matches as the *outer* link — with a flat
// `[^\]]*` label the match stopped at the image's `]` and the outer target was
// never seen. The target admits one level of balanced parens so a Wikipedia-
// style URL (`/wiki/Foo_(bar)`) isn't truncated at its first `)`.
const MD_LINK =
  /\[(?<label>(?:[^[\]]|\[[^\]]*\])*)\]\((?<target>(?:[^()\s]|\([^()\s]*\))+)(?<title>\s+"[^"]*")?\)/gu;
// An image inside a link label; its target was matched (and so validated) as a
// link of its own before labels admitted nesting, and still should be.
export const MD_IMAGE =
  /!\[[^\]]*\]\((?<target>(?:[^()\s]|\([^()\s]*\))+)(?<title>\s+"[^"]*")?\)/gu;

/** Column (0-based, within `matched`) where a link/image match's target starts. */
export const targetOffsetIn = (
  matched: string,
  target: string,
  title: string | undefined
): number => matched.length - 1 - (title?.length ?? 0) - target.length;

/**
 * Extract link targets from a markdown body for later validation, recording the
 * 1-based line/column of each target. Skips fenced code blocks and inline code.
 * `lineOffset` shifts every recorded line: the body is frontmatter-stripped, so
 * diagnostics that point into the raw file must add the stripped block's height.
 */
/** Scan one line for link targets; returns the next fenced-block state. */
const scanLinkLine = (
  line: string,
  lineNumber: number,
  fence: FenceState,
  links: PageLink[]
): FenceState => {
  const next = nextFenceState(line, fence);
  // Skip fence delimiter lines themselves and anything inside a fence.
  if (fence !== null || next !== null) {
    return next;
  }
  // Blank out inline code spans (`[label](/x)` shown as syntax, not a link)
  // with same-length padding so recorded columns stay accurate.
  const masked = line.replaceAll(INLINE_CODE, (span) =>
    " ".repeat(span.length)
  );
  for (const match of masked.matchAll(MD_LINK)) {
    const target = match.groups?.target;
    if (target === undefined || match.index === undefined) {
      continue;
    }
    // Locate the target by arithmetic from the match end rather than searching
    // for its text — a label that contains the same text (e.g. `[/a/b](/a/b)`)
    // would otherwise report the column inside the label.
    const targetOffset = targetOffsetIn(match[0], target, match.groups?.title);
    const entry: PageLink = {
      column: match.index + targetOffset + 1,
      line: lineNumber,
      target,
    };
    // `MD_LINK` matches the `[label](target)` tail of an image embed too; the
    // preceding `!` is what marks the target as going through the image
    // pipeline rather than resolving as a site route.
    if (masked[match.index - 1] === "!") {
      entry.image = true;
    }
    links.push(entry);
    // An image nested in the label (`[![alt](/img.png)](/target)`) carries its
    // own target; surface it too so a missing image is still caught.
    const label = match[0].slice(0, targetOffset - "](".length);
    for (const image of label.matchAll(MD_IMAGE)) {
      const imageTarget = image.groups?.target;
      if (imageTarget === undefined || image.index === undefined) {
        continue;
      }
      links.push({
        column:
          match.index +
          image.index +
          targetOffsetIn(image[0], imageTarget, image.groups?.title) +
          1,
        image: true,
        line: lineNumber,
        target: imageTarget,
      });
    }
  }
  return next;
};

/**
 * A component's string `href` (`<Card href="./install" />`): the attribute
 * may sit on a later line than the tag name, where a formatter wraps a long
 * element, so the gap between them spans lines. An expression-valued
 * `href={…}` isn't a literal target, and a lowercase tag is raw HTML in a
 * `.md` page, so neither is matched.
 */
const COMPONENT_HREF =
  /<[A-Z][\w.]*(?=[\s/>])[^<>]*?\shref=(?:"(?<double>[^"]*)"|'(?<single>[^']*)')/gu;

/** The body with fenced blocks and inline code blanked, shape preserved. */
const maskCode = (lines: readonly string[]): string => {
  let fence: FenceState = null;
  const masked = lines.map((line) => {
    const next = nextFenceState(line, fence);
    const inFence = fence !== null || next !== null;
    fence = next;
    return inFence
      ? " ".repeat(line.length)
      : line.replaceAll(INLINE_CODE, (span) => " ".repeat(span.length));
  });
  return masked.join("\n");
};

/** Every component `href` target in `body`, with its 1-based position. */
const componentHrefs = (
  lines: readonly string[],
  lineOffset: number
): PageLink[] => {
  const links: PageLink[] = [];
  const text = maskCode(lines);
  for (const match of text.matchAll(COMPONENT_HREF)) {
    const target = match.groups?.double ?? match.groups?.single ?? "";
    // The value ends one character (its closing quote) before the match does.
    const at = match.index + match[0].length - target.length - 1;
    const before = text.slice(0, at);
    const lineStart = before.lastIndexOf("\n") + 1;
    links.push({
      column: at - lineStart + 1,
      line: lineOffset + before.split("\n").length,
      target,
    });
  }
  return links;
};

export const extractLinks = (body: string, lineOffset = 0): PageLink[] => {
  const links: PageLink[] = [];
  let fence: FenceState = null;
  let lineNumber = lineOffset;

  const lines = body.split("\n");
  for (const line of lines) {
    lineNumber += 1;
    fence = scanLinkLine(line, lineNumber, fence, links);
  }

  return body.includes("href=")
    ? [...links, ...componentHrefs(lines, lineOffset)]
    : links;
};

// Double-quoted strings hold JSX attribute values and JSON in `{...}` props; a
// `<Tag>` written inside prose there (e.g. an "Astro <Font> integration" note)
// isn't a real usage. Single quotes are left alone so prose apostrophes don't
// swallow a real tag between two words.
const DOUBLE_QUOTED = /"[^"]*"/gu;
const JSX_OPEN = /<(?<tag>[A-Z][A-Za-z0-9]*)/gu;

/**
 * Capitalized JSX component tags used in an `.mdx` body (`<Callout>`,
 * `<Tree.File>` → `Tree`). Skips fenced code, inline code, and double-quoted
 * strings so code samples and prose don't count. Powers the missing-component
 * diagnostic.
 */
/** Scan one line for JSX component tags; returns the next fenced-block state. */
const scanTagLine = (
  line: string,
  fence: FenceState,
  tags: Set<string>
): FenceState => {
  const next = nextFenceState(line, fence);
  // Skip fence delimiter lines themselves and anything inside a fence.
  if (fence !== null || next !== null) {
    return next;
  }
  const clean = line.replaceAll(INLINE_CODE, "").replaceAll(DOUBLE_QUOTED, "");
  for (const match of clean.matchAll(JSX_OPEN)) {
    const tag = match.groups?.tag;
    if (tag) {
      tags.add(tag);
    }
  }
  return next;
};

export const extractComponentTags = (body: string): string[] => {
  const tags = new Set<string>();
  let fence: FenceState = null;
  for (const line of body.split("\n")) {
    fence = scanTagLine(line, fence, tags);
  }
  return [...tags];
};

/**
 * Height of the frontmatter block stripped from `raw` to produce `body` (0
 * when the raw text is unknown or nothing was stripped). Link positions are
 * extracted from the stripped body, but diagnostics point into the raw
 * document — recorded lines must shift by this offset to match it.
 */
export const strippedLineOffset = (
  raw: string | undefined,
  body: string
): number =>
  raw ? Math.max(0, raw.split("\n").length - body.split("\n").length) : 0;

/**
 * How many lines of the entry's source file sit above its body: what the
 * source reported (`bodyLineOffset`, when `raw` is a rewrite of the file), or
 * else the height of `raw`'s stripped front matter.
 */
const entryLineOffset = (entry: SourceEntry): number =>
  entry.bodyLineOffset ?? strippedLineOffset(entry.raw, entry.body.text);

/**
 * Map links extracted from include-expanded text back to the file and raw
 * line each expanded line came from, so a broken link inside a partial is
 * reported against the partial. Links whose origin is the page's own source
 * carry no `file` override (origins already hold raw-file lines).
 */
const remapExpandedLinks = (
  links: PageLink[],
  origins: { file: string; line: number }[],
  sourcePath: string | undefined
): PageLink[] =>
  links.map((link) => {
    const origin = origins[link.line - 1];
    if (!origin) {
      return link;
    }
    const remapped: PageLink = { ...link, line: origin.line };
    if (origin.file !== sourcePath) {
      remapped.file = origin.file;
    }
    return remapped;
  });

/** The entry's transitively included files, when the scan expanded any. */
const entryIncludes = (entry: SourceEntry): string[] | undefined =>
  entry.expanded && entry.expanded.includes.length > 0
    ? entry.expanded.includes
    : undefined;

/**
 * Extract an entry's links for validation. When the scan expanded includes,
 * extraction runs over the expanded text (origins already hold raw-file
 * lines); otherwise over the stripped body, shifted by the stripped front
 * matter block's height.
 */
const entryLinks = (entry: SourceEntry): PageLink[] =>
  entry.expanded
    ? remapExpandedLinks(
        extractLinks(entry.expanded.text),
        entry.expanded.origins,
        entry.sourcePath
      )
    : extractLinks(entry.body.text, entryLineOffset(entry));

/**
 * Diagnostics for `{#id}` heading markers in an `.mdx` page. The MDX parser
 * reads a bare `{…}` as a JSX expression, so the page fails to compile —
 * reported here, at the marker's source line, instead of as a raw acorn error
 * at render time. An included `.md` partial is spliced into the including
 * page and parsed in *its* format (see `markdown/include.ts`), so a partial's
 * markers count too and are reported against the partial via the expansion's
 * origins. `.md` pages render the marker as text and get no diagnostic.
 */
const curlyMarkerDiagnostics = (
  entry: SourceEntry,
  markers: CurlyMarker[],
  sourceName: string
): Diagnostic[] =>
  markers.map(({ id, line }) => {
    const origin = entry.expanded?.origins[line - 1];
    const page = entry.sourcePath ?? `${sourceName}:${entry.ref}`;
    const inPartial = origin !== undefined && origin.file !== entry.sourcePath;
    return {
      code: "BLUME_MDX_CURLY_ANCHOR",
      file: origin?.file ?? page,
      line: origin?.line ?? line + entryLineOffset(entry),
      message: inPartial
        ? `\`{#${id}}\` is a JSX expression once this partial is included in ${page} (.mdx), so that page fails to compile.`
        : `\`{#${id}}\` is a JSX expression in .mdx, so this page fails to compile.`,
      severity: "error",
      suggestion: `Write \`[#${id}]\` or escape it as \`\\{#${id}\\}\` — both pin the same anchor in .md and .mdx.`,
    };
  });

const deriveTitle = (
  meta: PageMeta,
  headings: Heading[],
  id: string
): string => {
  if (meta.title) {
    return meta.title;
  }
  const firstHeading = headings.find((h) => h.depth === 1) ?? headings[0];
  if (firstHeading) {
    return firstHeading.text;
  }
  const parts = id.split("/");
  const base = parts.at(-1) ?? id;
  const stem = stripNumericPrefix(base.replace(extname(base), ""));
  // An index page stands for its folder, so an untitled one takes the label
  // the sidebar gives that folder (`guides/index.md` is "Guides"). The
  // content root's own index has no folder to borrow from.
  const folder = stem === "index" ? parts.at(-2) : undefined;
  if (folder !== undefined) {
    return titleCase(stripNumericPrefix(orderedGroupLabel(folder) ?? folder));
  }
  return titleCase(stem);
};

/** Strip habitual leading/trailing slashes (`/getting-started`, `guides/`). */
const trimSlashes = (value: string): string => trimChar(value, "/");

/** Whether a raw frontmatter value is a string (e.g. the `type` override). */
export const isStringValue = (
  value: SourceEntry["data"][string]
): value is string => typeof value === "string";

/** Mount a source-relative path under the source's route prefix. */
const withPrefix = (prefix: string | undefined, path: string): string => {
  const clean = prefix ? trimSlashes(prefix) : "";
  return clean ? `${clean}/${path}` : path;
};

/** What a route resolution needs from the owning source and the config. */
export type RouteContext = Pick<NormalizeContext, "i18n" | "versions"> & {
  /**
   * Whether the entry's ref is a path of file and folder names whose ordering
   * prefixes (`01-intro`) sort the sidebar and drop from the route: true for
   * filesystem sources. A staged source's ref is a slug, a release tag, or a
   * note name, and keeps its leading numbers.
   */
  orderingPrefixes?: boolean;
  /** The source's route prefix (`NormalizeContext["source"]["prefix"]`). */
  prefix?: string;
};

/** Where an entry's ref places it once its directories are read off. */
export interface EntryPlacement {
  /**
   * The locale codes the entry publishes in: `[""]` without i18n, one code for
   * a placed file, every configured code for a shared `$` file.
   */
  locales: string[];
  /** The ref with its version and locale directories stripped, prefix-less. */
  navPath: string;
  /** The version snapshot the entry belongs to (`""` for current). */
  version: string;
}

/**
 * Read the version and locale directories off an entry's ref. The version is
 * detected first: a snapshot directory is outermost on disk
 * (`v1.0/fr/page.mdx`), so the locale parser must see a version-stripped ref.
 * The current version is `""` and lives at the root. Locale placement comes
 * from the ref (a leading dir, or a filename suffix under the `dot` parser),
 * never the slug — the slug is the logical, locale-agnostic path within a
 * locale. A shared `$` file maps to every locale; a source without i18n
 * placement maps to one.
 */
export const placeEntryRef = (
  ref: string,
  ext: string,
  ctx: Pick<RouteContext, "i18n" | "versions">
): EntryPlacement => {
  const { version, rest } = ctx.versions
    ? detectVersionRef(ref, ctx.versions)
    : { rest: ref, version: "" };
  const { navPath, locales } = ctx.i18n
    ? localePlacement(rest, ext, ctx.i18n)
    : { locales: [""], navPath: rest };
  return { locales, navPath, version };
};

/** Everything `normalizeEntry` derives from an entry's ref and slug. */
export interface EntryRoute extends Pick<
  EntryPlacement,
  "locales" | "version"
> {
  groups: string[];
  /**
   * The version-prefixed, locale-agnostic route — the translation key. Pass it
   * through {@link localizedRoute} for the route one locale publishes at.
   */
  logicalRoute: string;
  /** The prefixed, locale- and version-stripped nav path. */
  navPath: string;
  segments: string[];
  /** The version-agnostic mapped route. */
  versionKey: string;
}

/**
 * The canonical route resolution, shared by {@link normalizeEntry} and any
 * source that must predict the route an entry will publish at — the Obsidian
 * source turns `[[Note]]` into a real href, and a second derivation of a route
 * is a second answer.
 *
 * A frontmatter `slug` wins, then the adapter-supplied `entry.slug` (the typed
 * SPI's "logical route input; defaults to ref if omitted"), then the ref. The
 * extension is re-appended so `mapRoute`'s extname strip can't eat a dotted
 * slug segment (`v1.2`). A slug that trims to nothing falls back. Only a
 * filesystem ref (`ctx.orderingPrefixes`) loses its ordering prefixes; a slug
 * is a route spelled out, so `2024-year-in-review` stays whole. The version
 * prefixes the mapped route *after* `mapRoute` runs: the mapped route is the
 * version-agnostic key, the config id is prepended verbatim (never
 * numeric-prefix-stripped), a frontmatter `slug` gets versionized so snapshots
 * can't collide with the live page, and `translationKey` becomes
 * version-specific for free. `basePath` is not applied here — it is outermost,
 * after locale prefixing — so the result reads `{locale?}/{prefix?}/…`.
 */
export const resolveEntryRoute = (
  entry: Pick<SourceEntry, "ref" | "slug">,
  ext: string,
  frontmatterSlug: string | undefined,
  ctx: RouteContext
): EntryRoute => {
  const { locales, navPath, version } = placeEntryRef(entry.ref, ext, ctx);
  const slugInput = frontmatterSlug ?? entry.slug;
  const slug = slugInput ? trimSlashes(slugInput) : "";
  // A frontmatter slug is a route spelled out; an adapter's `entry.slug` is
  // one too unless the source's names are ordered file names (a vault note's
  // path), which lose their prefixes like the ref does.
  const ordered =
    ctx.orderingPrefixes === true && frontmatterSlug === undefined;
  const {
    segments,
    groups,
    route: versionKey,
  } = slug
    ? mapRoute(ctx.prefix, `${slug}${ext}`, ordered)
    : mapRoute(ctx.prefix, navPath, ctx.orderingPrefixes === true);
  return {
    groups,
    locales,
    logicalRoute: versionizeRoute(versionKey, version),
    navPath: withPrefix(ctx.prefix, navPath),
    segments,
    version,
    versionKey,
  };
};

/** The route a logical route publishes at in one locale, base path excluded. */
export const localizedRoute = (
  logicalRoute: string,
  locale: string,
  i18n: ResolvedI18nConfig | undefined
): string => (i18n ? localizeRoute(logicalRoute, locale, i18n) : logicalRoute);

/** A custom-key validation failure, lowered to a joinable diagnostic path. */
interface CustomKeyIssue {
  message: string;
  path: (string | number)[];
}

/** The validated custom keys (if any survived) plus every failure found. */
interface CustomKeyValidation {
  custom?: PageRecord["custom"];
  issues: CustomKeyIssue[];
}

/** Whether a Standard Schema path segment is the wrapped `{ key }` form. */
const isKeyCarrier = (
  segment: PropertyKey | { readonly key: PropertyKey }
): segment is { readonly key: PropertyKey } =>
  typeof segment === "object" && segment !== null;

const isSymbolKey = (key: PropertyKey): key is symbol =>
  typeof key === "symbol";

/** Lower a Standard Schema path segment (`key` or `{ key }`) for joining. */
const segmentKey = (
  segment: PropertyKey | { readonly key: PropertyKey }
): string | number => {
  const key = isKeyCarrier(segment) ? segment.key : segment;
  return isSymbolKey(key) ? String(key) : key;
};

/**
 * Validate the opt-in custom frontmatter keys (`frontmatter.extend` and
 * `content.types.<type>.frontmatter`) through the Standard Schema contract —
 * the consumer's own Zod (any version), Valibot, or ArkType, never Blume's
 * bundled zod (see `standard-schema.ts`). Every declared key is checked,
 * absent ones included, so a required schema enforces its key on every page
 * it applies to. Async schemas are rejected with a diagnostic: this funnel is
 * synchronous, and frontmatter validation has no business awaiting I/O.
 */
const validateCustomKeys = (
  data: SourceEntry["data"],
  extend: FrontmatterExtend
): CustomKeyValidation => {
  const custom: NonNullable<PageRecord["custom"]> = {};
  const issues: CustomKeyIssue[] = [];
  for (const [key, schema] of Object.entries(extend)) {
    const outcome = schema["~standard"].validate(data[key]);
    if (outcome instanceof Promise) {
      issues.push({
        message: "Async schemas are not supported for custom frontmatter keys.",
        path: [key],
      });
      continue;
    }
    if (outcome.issues !== undefined) {
      issues.push(
        ...outcome.issues.map((issue) => ({
          message: issue.message,
          path: [key, ...(issue.path ?? []).map(segmentKey)],
        }))
      );
      continue;
    }
    // Preserve the validated (schema-output) value; skip keys that are absent
    // and stay absent, so `.optional()` extras don't materialize as undefined.
    if (outcome.value !== undefined || Object.hasOwn(data, key)) {
      custom[key] = outcome.value;
    }
  }
  return {
    custom: Object.keys(custom).length > 0 ? custom : undefined,
    issues,
  };
};

// A `.` or `..` path segment, which a browser resolves away before requesting.
const DOT_SEGMENT = /(?:^|\/)\.{1,2}(?:\/|$)/u;

/**
 * A frontmatter `slug` with a `.` or `..` segment names no reachable URL: a
 * browser normalizes the link (`guides/./x` → `guides/x`, `../x` → `/x`)
 * before requesting it, and `..` would have Astro write the page outside the
 * build output. Rejected alongside the schema's own errors.
 */
const slugIssues = (slug: string | undefined): CustomKeyIssue[] =>
  slug !== undefined && DOT_SEGMENT.test(slug)
    ? [
        {
          message: `"${slug}" has a "." or ".." segment, which browsers resolve away, so no link could reach the page. Write the route out from the content root.`,
          path: ["slug"],
        },
      ]
    : [];

/**
 * Parse an entry's frontmatter: built-in keys through the strict page schema,
 * custom keys (`frontmatter.extend` plus the page type's
 * `content.types.<type>.frontmatter`) through their user-supplied schemas.
 * The custom keys are carved out before the strict parse, so the page schema
 * stays strict for everything else and unknown-key typo catching is unchanged
 * — a key declared only for some other type stays unknown here.
 * Returns diagnostics instead of meta when either side rejects.
 */
const parseEntryMeta = (
  entry: SourceEntry,
  ctx: NormalizeContext
):
  | { meta: PageMeta; custom?: PageRecord["custom"]; diagnostics?: never }
  | { meta?: never; diagnostics: Diagnostic[] } => {
  // Resolved the same way `contentType` is after parsing (`meta.type` falling
  // back to `defaultType`); a non-string `type` fails the strict parse below,
  // so which per-type map was merged for that entry never matters.
  const entryType = isStringValue(entry.data.type)
    ? entry.data.type
    : ctx.defaultType;
  const typeExtend = ctx.typeFrontmatter?.[entryType];
  // Config validation rejects a key declared both site-wide and per-type, so
  // this merge never has to pick a winner.
  const extend =
    ctx.frontmatterExtend || typeExtend
      ? { ...ctx.frontmatterExtend, ...typeExtend }
      : undefined;
  const known = extend
    ? Object.fromEntries(
        Object.entries(entry.data).filter(
          ([key]) => !Object.hasOwn(extend, key)
        )
      )
    : entry.data;

  const result = pageMetaSchema.safeParse(known);
  const customResult = extend ? validateCustomKeys(entry.data, extend) : null;
  const issues = [
    ...(result.success ? slugIssues(result.data.slug) : []),
    ...(customResult?.issues ?? []),
  ];

  if (result.success && issues.length === 0) {
    return { custom: customResult?.custom, meta: result.data };
  }

  // Source text lets the error carry a line/column into the frontmatter block:
  // `entry.raw` for non-filesystem sources, else the file itself (read only on
  // this rare error path, so filesystem entries stay cheap in the happy path).
  const source =
    entry.raw ??
    (entry.sourcePath && existsSync(entry.sourcePath)
      ? readFileSync(entry.sourcePath, "utf-8")
      : undefined);
  const location = {
    code: "BLUME_FRONTMATTER_INVALID",
    file: entry.sourcePath ?? `${ctx.source.name}:${entry.ref}`,
    source,
  };
  return {
    diagnostics: [
      ...(result.success ? [] : diagnosticsFromZod(result.error, location)),
      ...diagnosticsFromIssues(issues, location),
    ],
  };
};

/** The per-locale page records and diagnostics from one source entry. */
export interface NormalizedEntry {
  pages: PageRecord[];
  diagnostics: Diagnostic[];
}

/**
 * Normalize one source entry into per-locale `PageRecord`s. This is the single
 * funnel every adapter's entries pass through, so route mapping, heading/link
 * extraction, and meta validation are identical regardless of origin.
 */
export const normalizeEntry = (
  entry: SourceEntry,
  ctx: NormalizeContext
): NormalizedEntry => {
  const { format } = entry.body;
  const ext = format === "mdx" ? ".mdx" : ".md";

  const parsed = parseEntryMeta(entry, ctx);
  if (parsed.diagnostics) {
    return { diagnostics: parsed.diagnostics, pages: [] };
  }

  const { meta } = parsed;

  // Top-level `hidden`/`noindex` are accepted as shorthands for their nested
  // equivalents — the schema declares them, so silently ignoring them would
  // strand authors with no diagnostic.
  if (meta.hidden) {
    meta.sidebar.hidden = true;
  }
  if (meta.noindex) {
    meta.seo.noindex = true;
  }

  const {
    groups,
    locales,
    logicalRoute,
    navPath,
    segments,
    version,
    versionKey,
  } = resolveEntryRoute(entry, ext, meta.slug, {
    i18n: ctx.i18n,
    orderingPrefixes: !ctx.source.staged || ctx.source.orderedNames === true,
    prefix: ctx.source.prefix,
    versions: ctx.versions,
  });
  // Extraction runs on the include-expanded body when the scan expanded one,
  // so a partial's headings anchor-index and TOC under every including page
  // and its components register for the runtime import map.
  const bodyText = entry.expanded?.text ?? entry.body.text;
  const { anchors, curlyMarkers, headings } = scanBody(bodyText);
  const { staged } = ctx.source;

  const base = {
    anchors,
    body: staged ? { format, text: entry.raw ?? entry.body.text } : undefined,
    collection: staged ? "staged" : undefined,
    componentsUsed:
      format === "mdx" ? extractComponentTags(bodyText) : undefined,
    contentType: meta.type ?? ctx.defaultType,
    custom: parsed.custom,
    description: meta.description,
    editUrl: entry.editUrl,
    entryId: staged ? `${ctx.source.name}/${entry.ref}` : undefined,
    format,
    groups,
    headings,
    id: `${ctx.source.name}:${entry.ref}`,
    includes: entryIncludes(entry),
    lastModified: meta.lastModified ?? entry.lastModified,
    links: entryLinks(entry),
    meta,
    monolingual: ctx.source.monolingual,
    navPath,
    segments,
    source: { name: ctx.source.name, ref: entry.ref },
    sourcePath: entry.sourcePath,
    title: deriveTitle(meta, headings, navPath),
    translationKey: logicalRoute,
    version,
    versionKey,
  } satisfies Omit<PageRecord, "locale" | "route">;

  // One record per locale this entry maps to (one normally; every locale for a
  // shared `$` file). All share the same id, source ref, and translation key.
  // `basePath` is applied outermost — after locale prefixing — so the route
  // reads `{basePath}/{locale?}/{prefix?}/…`; `navPath` and `translationKey`
  // stay base-less so the nav tree and translation matching are unaffected.
  // The base is mounted unconditionally: a `docs/` folder under a `/docs`
  // base is a real `/docs/docs/…` route, not an already-based one.
  const pages = locales.map((locale) => ({
    ...base,
    locale,
    route: mountBasePath(
      ctx.basePath ?? "",
      localizedRoute(logicalRoute, locale, ctx.i18n)
    ),
  }));

  return {
    diagnostics:
      format === "mdx"
        ? curlyMarkerDiagnostics(entry, curlyMarkers, ctx.source.name)
        : [],
    pages,
  };
};

import { existsSync, readFileSync } from "node:fs";

import GithubSlugger from "github-slugger";
import { extname } from "pathe";

import { withBasePath } from "../base-path.ts";
import { diagnosticsFromIssues, diagnosticsFromZod } from "../diagnostics.ts";
import { occupySlug, parseHeadingMarkers } from "../heading-markers.ts";
import { localePlacement, localizeRoute } from "../i18n.ts";
import { pageMetaSchema } from "../schema.ts";
import type {
  FrontmatterExtend,
  PageMeta,
  ResolvedI18nConfig,
} from "../schema.ts";
import type { Diagnostic, Heading, PageLink, PageRecord } from "../types.ts";
import { detectVersionRef, versionizeRoute } from "../versions.ts";
import type { NormalizeContext, SourceEntry } from "./types.ts";

const NUMERIC_PREFIX = /^\d+[-_.]/u;
const GROUP_FOLDER = /^\((?<label>.+)\)$/u;
const WORD_SPLIT = /[-_]/u;

/** Strip a leading numeric ordering prefix (`01-intro` -> `intro`). */
const stripNumericPrefix = (segment: string): string =>
  segment.replace(NUMERIC_PREFIX, "");

/** Detect a group folder `(name)` and return its label, else null. */
const groupLabel = (segment: string): string | null =>
  segment.match(GROUP_FOLDER)?.groups?.label ?? null;

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

/** Title-case a slug segment for display. */
const titleCase = (value: string): string =>
  value
    .split(WORD_SPLIT)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

/**
 * Strip characters that cannot survive the route → URL → output-file round
 * trip. A `:` ahead of the first `/` makes `new URL()` read the segment as a
 * scheme (`Guide: Architecture.md` → `guide:`), which crashes Astro's
 * prerender write with "The URL must be of scheme file"; control characters
 * (an embedded newline in a filename) are silently dropped by the URL parser,
 * desyncing the route from its output path. Both are legal in macOS/Linux
 * filenames, so they are removed here rather than rejected.
 */
const sanitizeSegment = (segment: string): string =>
  segment.replaceAll(/[:\p{Cc}]/gu, "");

/** Fold one raw path part into the accumulating route segments/groups. */
const addRouteSegment = (
  part: string,
  segments: string[],
  groups: string[]
): void => {
  // A leading/trailing/double slash yields an empty part; keeping it would
  // produce a malformed route (`//foo`, `/foo/`) that nothing can link to.
  if (part === "") {
    return;
  }
  const group = groupLabel(part);
  if (group !== null) {
    groups.push(group);
    return;
  }
  const clean = stripNumericPrefix(part);
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
 * Convert a content-root-relative path into URL + nav metadata. Not exported:
 * a source that needs to predict a route goes through
 * {@link resolveEntryRoute}, so there is exactly one derivation.
 */
const mapRoute = (relativePath: string): MappedRoute => {
  const withoutExt = relativePath.slice(
    0,
    relativePath.length - extname(relativePath).length
  );
  const rawParts = withoutExt.split("/");

  const segments: string[] = [];
  const groups: string[] = [];

  for (const part of rawParts) {
    addRouteSegment(part, segments, groups);
  }

  const route = segments.length === 0 ? "/" : `/${segments.join("/")}`;
  return { groups, route, segments };
};

// CommonMark allows backtick *and* tilde fences, three or more characters
// long. The scanners track which delimiter opened the current fence and how
// long its run was (`null` when outside one), so a ``` line inside a ~~~
// block — or inside a ````-delimited block (the wrapper `codeBlockLines`
// emits around code that contains its own ``` fence) — is content, not a
// toggle. See `nextFenceState`.
const CODE_FENCE = /^(?<run>`{3,}|~{3,})/u;

/** The open fence's delimiter char and run length, or null outside one. */
export type FenceState = { delimiter: "`" | "~"; length: number } | null;

/**
 * Advance the fenced-code state for one line: an opening fence records its
 * delimiter and run length, only a run of the same character at least as long
 * closes it (CommonMark), and any other line leaves the state untouched.
 */
export const nextFenceState = (line: string, fence: FenceState): FenceState => {
  const trimmed = line.trimStart();
  const run = trimmed.match(CODE_FENCE)?.groups?.run;
  if (run === undefined) {
    return fence;
  }
  const delimiter = run.startsWith("`") ? ("`" as const) : ("~" as const);
  if (fence === null) {
    // A backtick fence's info string cannot itself contain a backtick
    // (CommonMark) — a line-leading ```inline``` span is a paragraph, and
    // opening a phantom fence on it would swallow every heading and link
    // after it. Tilde fences carry no such rule.
    if (delimiter === "`" && trimmed.slice(run.length).includes("`")) {
      return fence;
    }
    return { delimiter, length: run.length };
  }
  return fence.delimiter === delimiter && run.length >= fence.length
    ? null
    : fence;
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
const FRONT_MATTER_CLOSE = /^(?:-{3}|\.{3})\s*$/u;
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

/**
 * The body lines, minus a leading front matter block. Bodies from the
 * normalize pipeline are already frontmatter-stripped, but `extractHeadings`
 * also runs on raw documents — where a leading `---` block (closed by `---` or
 * `...`) is front matter, not a thematic break whose closing `---` would
 * underline the last metadata line into a phantom setext heading.
 */
const linesWithoutFrontMatter = (body: string): string[] => {
  const lines = body.split("\n");
  if (!/^-{3}\s*$/u.test(lines[0] ?? "")) {
    return lines;
  }
  // A blank line directly after the dashes means the body *opens* with a
  // thematic break, not front matter — YAML metadata starts on the very next
  // line. Treating it as an unclosed block ate everything up to the next
  // `---`/`...` line of an already-stripped body.
  if ((lines[1] ?? "").trim() === "") {
    return lines;
  }
  const close = lines.findIndex(
    (line, index) => index > 0 && FRONT_MATTER_CLOSE.test(line)
  );
  return close === -1 ? lines : lines.slice(close + 1);
};

/** Scanner state: the open fence plus the paragraph lines accumulated so far. */
interface HeadingScanState {
  fence: FenceState;
  /** Consecutive paragraph lines — the candidate text for a setext underline. */
  paragraph: string[];
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
// CommonMark's escapable ASCII punctuation. The renderer only ever sees
// heading text *after* the Markdown parser has resolved backslash escapes, so
// `\[toc]` reaches the hast as plain `[toc]` and the marker still applies;
// resolving escapes here keeps the two pipelines identical (there is no
// inline way to write a literal trailing marker — use inline code instead).
const ESCAPED_PUNCTUATION = /\\(?<char>[!-/:-@[-`{-~])/gu;

// A link-reference definition line: `[label]: /url`, up to 3 leading spaces.
const REF_DEFINITION = /^ {0,3}\[(?<label>[^\]]+)\]:/u;

/**
 * The normalized labels of every link-reference definition in the body
 * (outside fenced code). A trailing heading bracket whose label is defined is
 * a CommonMark shortcut link, not a marker — the renderer leaves it in the
 * heading as an `<a>`, so the marker parse must skip it too. Labels match
 * case-insensitively with collapsed internal whitespace (CommonMark).
 */
const refDefinitionLabels = (lines: readonly string[]): Set<string> => {
  const labels = new Set<string>();
  let fence: FenceState = null;
  for (const line of lines) {
    const next = nextFenceState(line, fence);
    if (fence !== null || next !== null) {
      fence = next;
      continue;
    }
    const label = line.match(REF_DEFINITION)?.groups?.label;
    if (label !== undefined) {
      labels.add(label.trim().replaceAll(/\s+/gu, " ").toLowerCase());
    }
  }
  return labels;
};

/**
 * A heading record from raw heading text: escapes resolved and trailing
 * markers stripped, exactly as the renderer sees them. A `[#custom-id]` pin
 * becomes the slug verbatim and — matching the renderer — occupies its id in
 * the slugger, so a later heading whose auto-slug collides disambiguates
 * (`setup` → `setup-1`). `[!toc]`/`[toc]` headings stay in the record: their
 * ids exist in the rendered page, so links to them are valid anchors
 * regardless of TOC visibility. A heading that is nothing but markers keeps
 * them as literal text, mirroring the renderer.
 */
const toHeading = (
  depth: number,
  raw: string,
  slugger: GithubSlugger,
  isRefDefined: (label: string) => boolean
): Heading => {
  const unescaped = raw.replaceAll(ESCAPED_PUNCTUATION, "$<char>");
  const markers = parseHeadingMarkers(unescaped, isRefDefined);
  const text = markers.text.trim();
  if (text === "" && (markers.id !== undefined || markers.toc !== undefined)) {
    return { depth, slug: slugger.slug(unescaped), text: unescaped };
  }
  if (markers.id !== undefined) {
    occupySlug(slugger, markers.id);
    return { depth, slug: markers.id, text };
  }
  return { depth, slug: slugger.slug(text), text };
};

/** Scan one line for a heading, advancing the fence/paragraph state. */
const scanHeadingLine = (
  line: string,
  state: HeadingScanState,
  slugger: GithubSlugger,
  headings: Heading[],
  isRefDefined: (label: string) => boolean
): void => {
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
  const atx = line.match(ATX_HEADING);
  if (atx?.groups) {
    const depth = atx.groups.hashes?.length ?? 1;
    headings.push(
      toHeading(depth, (atx.groups.text ?? "").trim(), slugger, isRefDefined)
    );
    state.paragraph = [];
    return;
  }
  const setext = line.match(SETEXT_UNDERLINE);
  if (setext?.groups && state.paragraph.length > 0) {
    // Setext wins over thematic break when it closes a paragraph (CommonMark);
    // a multi-line paragraph renders as one heading, soft breaks as spaces.
    const depth = setext.groups.marker?.startsWith("=") ? 1 : 2;
    headings.push(
      toHeading(depth, state.paragraph.join(" ").trim(), slugger, isRefDefined)
    );
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
  state.paragraph.push(line.trim());
};

export const extractHeadings = (body: string): Heading[] => {
  const headings: Heading[] = [];
  const slugger = new GithubSlugger();
  const state: HeadingScanState = {
    fence: null,
    paragraph: [],
    promptDepth: 0,
    promptTag: false,
  };

  const lines = linesWithoutFrontMatter(body);
  const definedLabels = refDefinitionLabels(lines);
  const isRefDefined = (label: string): boolean =>
    definedLabels.has(label.toLowerCase());
  for (const line of lines) {
    scanHeadingLine(line, state, slugger, headings, isRefDefined);
  }

  return headings;
};

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
export const INLINE_CODE = /`[^`]*`/gu;

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

export const extractLinks = (body: string, lineOffset = 0): PageLink[] => {
  const links: PageLink[] = [];
  let fence: FenceState = null;
  let lineNumber = lineOffset;

  for (const line of body.split("\n")) {
    lineNumber += 1;
    fence = scanLinkLine(line, lineNumber, fence, links);
  }

  return links;
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
    : extractLinks(
        entry.body.text,
        strippedLineOffset(entry.raw, entry.body.text)
      );

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
  const base = id.split("/").pop() ?? id;
  return titleCase(stripNumericPrefix(base.replace(extname(base), "")));
};

/** Strip habitual leading/trailing slashes (`/getting-started`, `guides/`). */
const trimSlashes = (value: string): string =>
  value.replaceAll(/^\/+|\/+$/gu, "");

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
 * slug segment (`v1.2`). A slug that trims to nothing falls back. The version
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
  const routeInput = withPrefix(ctx.prefix, slug ? `${slug}${ext}` : navPath);
  const { segments, groups, route: versionKey } = mapRoute(routeInput);
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

  if (result.success && (customResult?.issues.length ?? 0) === 0) {
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
      ...(customResult
        ? diagnosticsFromIssues(customResult.issues, location)
        : []),
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
    prefix: ctx.source.prefix,
    versions: ctx.versions,
  });
  // Extraction runs on the include-expanded body when the scan expanded one,
  // so a partial's headings anchor-index and TOC under every including page
  // and its components register for the runtime import map.
  const bodyText = entry.expanded?.text ?? entry.body.text;
  const headings = extractHeadings(bodyText);
  const { staged } = ctx.source;

  const base = {
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
  const pages = locales.map((locale) => ({
    ...base,
    locale,
    route: withBasePath(
      ctx.basePath ?? "",
      localizedRoute(logicalRoute, locale, ctx.i18n)
    ),
  }));

  return { diagnostics: [], pages };
};

import { existsSync, readFileSync } from "node:fs";

import GithubSlugger from "github-slugger";
import { extname } from "pathe";

import { withBasePath } from "../base-path.ts";
import { diagnosticsFromZod } from "../diagnostics.ts";
import { localePlacement, localizeRoute } from "../i18n.ts";
import { pageMetaSchema } from "../schema.ts";
import type { PageMeta } from "../schema.ts";
import type { Diagnostic, Heading, PageLink, PageRecord } from "../types.ts";
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
 */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .trim()
    .replaceAll(/[^\w\s-]/gu, "")
    .replaceAll(/[\s_]+/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replaceAll(/^-|-$/gu, "");

/** Title-case a slug segment for display. */
const titleCase = (value: string): string =>
  value
    .split(WORD_SPLIT)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

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
  segments.push(clean);
};

/** Convert a content-root-relative path into URL + nav metadata. */
const mapRoute = (
  relativePath: string
): { segments: string[]; groups: string[]; route: string } => {
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

// CommonMark allows backtick *and* tilde fences. The scanners track which
// delimiter opened the current fence (`null` when outside one) so a ``` line
// inside a ~~~ block is content, not a toggle — see `nextFenceState`.
const CODE_FENCE = /^(?<delimiter>```|~~~)/u;

/** The fence delimiter opening the current code block, or null outside one. */
type FenceState = "```" | "~~~" | null;

/**
 * Advance the fenced-code state for one line: an opening fence records its
 * delimiter, only the matching delimiter closes it, and any other line leaves
 * the state untouched.
 */
const nextFenceState = (line: string, fence: FenceState): FenceState => {
  const delimiter = line.trimStart().match(CODE_FENCE)?.groups?.delimiter as
    | Exclude<FenceState, null>
    | undefined;
  if (delimiter === undefined) {
    return fence;
  }
  if (fence === null) {
    return delimiter;
  }
  return fence === delimiter ? null : fence;
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
}

/**
 * Extract ATX and setext headings from a markdown body, skipping fenced code
 * blocks, exactly as the renderer sees them: ATX headings may be indented up
 * to 3 spaces, and a paragraph underlined with `=`/`-` is a level 1/2 setext
 * heading. Each heading's anchor slug comes from a per-document
 * `github-slugger` — the exact slugger the renderer uses
 * (`markdown/heading-anchors`) — advanced over every heading in document
 * order. Matching it (rather than a hand-rolled slugify) keeps the manifest's
 * anchor ids identical to the rendered ones, so `blume validate` stops
 * false-flagging links like `#the-read--write-fallback` (a hand slugify
 * collapses `--`; github-slugger keeps it) and resolves repeated headings the
 * same way (`setup`, `setup-1`).
 */
/** Scan one line for a heading, advancing the fence/paragraph state. */
const scanHeadingLine = (
  line: string,
  state: HeadingScanState,
  slugger: GithubSlugger,
  headings: Heading[]
): void => {
  const next = nextFenceState(line, state.fence);
  // Skip fence delimiter lines themselves and anything inside a fence. A fence
  // also ends any open paragraph, so no underline can reach across it.
  if (state.fence !== null || next !== null) {
    state.fence = next;
    state.paragraph = [];
    return;
  }
  const atx = line.match(ATX_HEADING);
  if (atx?.groups) {
    const depth = atx.groups.hashes?.length ?? 1;
    const text = (atx.groups.text ?? "").trim();
    headings.push({ depth, slug: slugger.slug(text), text });
    state.paragraph = [];
    return;
  }
  const setext = line.match(SETEXT_UNDERLINE);
  if (setext?.groups && state.paragraph.length > 0) {
    // Setext wins over thematic break when it closes a paragraph (CommonMark);
    // a multi-line paragraph renders as one heading, soft breaks as spaces.
    const text = state.paragraph.join(" ").trim();
    headings.push({
      depth: setext.groups.marker?.startsWith("=") ? 1 : 2,
      slug: slugger.slug(text),
      text,
    });
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
  const state: HeadingScanState = { fence: null, paragraph: [] };

  for (const line of linesWithoutFrontMatter(body)) {
    scanHeadingLine(line, state, slugger, headings);
  }

  return headings;
};

const MD_LINK = /\[[^\]]*\]\((?<target>[^)\s]+)(?:\s+"[^"]*")?\)/gu;
const INLINE_CODE = /`[^`]*`/gu;

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
    // Locate the target from the `](` boundary rather than searching for the
    // target text from the match start — otherwise a label that contains the
    // same text (e.g. `[/a/b](/a/b)`) reports the column inside the label. The
    // label can't contain `]`, so `](` is unambiguous.
    const targetOffset = match.index + match[0].indexOf("](") + "](".length;
    links.push({
      column: targetOffset + 1,
      line: lineNumber,
      target,
    });
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
const strippedLineOffset = (raw: string | undefined, body: string): number =>
  raw ? Math.max(0, raw.split("\n").length - body.split("\n").length) : 0;

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

const withPrefix = (prefix: string | undefined, path: string): string => {
  const clean = prefix ? trimSlashes(prefix) : "";
  return clean ? `${clean}/${path}` : path;
};

/**
 * Normalize one source entry into per-locale `PageRecord`s. This is the single
 * funnel every adapter's entries pass through, so route mapping, heading/link
 * extraction, and meta validation are identical regardless of origin.
 */
export const normalizeEntry = (
  entry: SourceEntry,
  ctx: NormalizeContext
): { pages: PageRecord[]; diagnostics: Diagnostic[] } => {
  const { format } = entry.body;
  const ext = format === "mdx" ? ".mdx" : ".md";

  const result = pageMetaSchema.safeParse(entry.data);
  if (!result.success) {
    // Source text lets the error carry a line/column into the frontmatter block:
    // `entry.raw` for non-filesystem sources, else the file itself (read only on
    // this rare error path, so filesystem entries stay cheap in the happy path).
    const source =
      entry.raw ??
      (entry.sourcePath && existsSync(entry.sourcePath)
        ? readFileSync(entry.sourcePath, "utf-8")
        : undefined);
    return {
      diagnostics: diagnosticsFromZod(result.error, {
        code: "BLUME_FRONTMATTER_INVALID",
        file: entry.sourcePath ?? `${ctx.source.name}:${entry.ref}`,
        source,
      }),
      pages: [],
    };
  }

  const meta = result.data;

  // Top-level `hidden`/`noindex` are accepted as shorthands for their nested
  // equivalents — the schema declares them, so silently ignoring them would
  // strand authors with no diagnostic.
  if (meta.hidden) {
    meta.sidebar.hidden = true;
  }
  if (meta.noindex) {
    meta.seo.noindex = true;
  }

  // Locale and the locale-stripped nav path come from the entry's ref (a leading
  // dir, or a filename suffix under the `dot` parser), not the slug — the slug is
  // the logical, locale-agnostic path within a locale. A shared `$` file maps to
  // every locale. Remote/CMS sources without i18n placement map to one locale.
  const { i18n } = ctx;
  const { navPath: rawNavPath, locales } = i18n
    ? localePlacement(entry.ref, ext, i18n)
    : { locales: [""], navPath: entry.ref };

  const navPath = withPrefix(ctx.source.prefix, rawNavPath);
  // Frontmatter `slug` wins, then the adapter-supplied `entry.slug` (the typed
  // SPI's "logical route input; defaults to ref if omitted"), then the ref.
  // The extension is re-appended so mapRoute's extname strip can't eat a
  // dotted slug segment (`v1.2`). A slug that trims to nothing falls back.
  const slugInput = meta.slug ?? entry.slug;
  const slug = slugInput ? trimSlashes(slugInput) : "";
  const routeInput = withPrefix(
    ctx.source.prefix,
    slug ? `${slug}${ext}` : rawNavPath
  );

  const { segments, groups, route: logicalRoute } = mapRoute(routeInput);
  const headings = extractHeadings(entry.body.text);
  const { staged } = ctx.source;

  const base = {
    body: staged ? { format, text: entry.raw ?? entry.body.text } : undefined,
    collection: staged ? "staged" : undefined,
    componentsUsed:
      format === "mdx" ? extractComponentTags(entry.body.text) : undefined,
    contentType: meta.type ?? ctx.defaultType,
    description: meta.description,
    editUrl: entry.editUrl,
    entryId: staged ? `${ctx.source.name}/${entry.ref}` : undefined,
    format,
    groups,
    headings,
    id: `${ctx.source.name}:${entry.ref}`,
    lastModified: meta.lastModified ?? entry.lastModified,
    links: extractLinks(
      entry.body.text,
      strippedLineOffset(entry.raw, entry.body.text)
    ),
    meta,
    navPath,
    segments,
    source: { name: ctx.source.name, ref: entry.ref },
    sourcePath: entry.sourcePath,
    title: deriveTitle(meta, headings, navPath),
    translationKey: logicalRoute,
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
      i18n ? localizeRoute(logicalRoute, locale, i18n) : logicalRoute
    ),
  }));

  return { diagnostics: [], pages };
};

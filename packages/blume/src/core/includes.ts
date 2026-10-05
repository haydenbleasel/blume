import { readFile } from "node:fs/promises";

import { dirname, extname, join, relative, resolve } from "pathe";

import { nextFenceState } from "./code-fences.ts";
import type { FenceState } from "./code-fences.ts";
import matter from "./frontmatter.ts";
import { INLINE_CODE, MD_IMAGE, targetOffsetIn } from "./sources/normalize.ts";
import type { Diagnostic } from "./types.ts";
import { substituteVariables } from "./variables.ts";

/**
 * Content includes: `<include>./relative.mdx</include>` on a line of its own
 * splices another file into the page at build time — the syntax Fumadocs
 * ships, so migrated content works unchanged. Markdown/MDX targets are
 * spliced as content (front matter stripped, nested includes resolved, cycle
 * detection); any other extension — or an explicit `lang` attribute — embeds
 * the file as a fenced code block, with optional `meta` for the fence meta
 * string (e.g. `title="config.ts"`).
 *
 * This module is the single owner of include semantics. The string-level
 * {@link expandIncludes} powers every surface that reads raw markdown source
 * (heading/link extraction, search indexing, the `/route.md` mirrors,
 * llms-full.txt), while {@link expandIncludeTarget} powers the Sätteri render
 * plugin, so what renders and what's indexed can't drift apart.
 */

/** Docs page targets: `.md`/`.mdx` splice as content; anything else is code. */
const CONTENT_EXTENSIONS = new Set([".md", ".mdx"]);

/**
 * A full include statement occupying one (trimmed) line: optional lowercase
 * attributes, then the target path as the element's text. Attribute values
 * accept both quote styles; a bare attribute (no `=`) is allowed so future
 * boolean flags parse rather than break the statement match.
 *
 * The target is anchored to non-space characters on both ends (rather than a
 * lazy run trimmed by the following `\s*`): a lazy `[^<>]*?` overlapping that
 * `\s*` backtracks quadratically on inputs like `<include>x` plus a long run
 * of spaces with no closing tag (CodeQL js/polynomial-redos). With both ends
 * pinned, a trailing space run is consumed by `\s*` alone and a failed match
 * stays linear.
 */
const INCLUDE_STATEMENT =
  /^<include(?<attrs>(?:\s+[a-z][\w-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*>\s*(?<target>[^<>\s](?:[^<>]*[^<>\s])?)\s*<\/include\s*>$/u;

/** One attribute within a statement's attrs run. */
const INCLUDE_ATTRIBUTE =
  /(?<name>[a-z][\w-]*)(?:\s*=\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)'))?/gu;

/**
 * Cheap pre-filter so include-free content (the overwhelmingly common case)
 * skips the line scan and file reads entirely.
 */
export const hasIncludeStatements = (text: string): boolean =>
  text.includes("<include");

/** A line indented four spaces (or a tab) — an indented code block in `.md`,
 * where the renderer shows a statement literally instead of splicing it. */
const INDENTED_CODE = /^(?: {4}|\t)/u;

/** A setext underline (`===`/`---`, up to 3 leading spaces): directly under a
 * statement line it folds the statement into a heading instead of a splice. */
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)\s*$/u;

/** Comment delimiters per format: `.md` uses HTML comments, `.mdx` JSX ones. */
const COMMENT_DELIMITERS = {
  md: { close: "-->", open: "<!--" },
  mdx: { close: "*/}", open: "{/*" },
} as const;

/**
 * Advance the comment state across one line: each open/close marker toggles
 * it, left to right. A line that *matches* a statement can't contain a marker
 * (the statement regex spans the whole trimmed line), so per-line state at the
 * line's start is all the statement scan needs.
 */
const advanceCommentState = (
  line: string,
  delimiters: { open: string; close: string },
  inComment: boolean
): boolean => {
  let inside = inComment;
  let cursor = 0;
  for (;;) {
    const marker = inside ? delimiters.close : delimiters.open;
    const index = line.indexOf(marker, cursor);
    if (index === -1) {
      return inside;
    }
    inside = !inside;
    cursor = index + marker.length;
  }
};

/** The attributes an include statement supports. */
export interface IncludeAttributes {
  /** Force code-block mode with this language (even for `.md`/`.mdx`). */
  lang?: string;
  /** Fence meta string in code-block mode (e.g. `title="lib.ts"`). */
  meta?: string;
  /**
   * Every other attribute with a value: the snippet's own variables.
   * `<include plan="Pro">` makes `{{plan}}` in the included file read `Pro`,
   * ahead of any site-wide variable of the same name.
   */
  props?: Record<string, string>;
}

/** A parsed include statement. */
export interface IncludeStatement {
  target: string;
  attributes: IncludeAttributes;
}

/**
 * Parse one trimmed line as an include statement, or `null` when it isn't
 * one. `lang` and `meta` shape a code include; every other attribute with a
 * value becomes a prop, a variable scoped to the included file.
 */
export const parseIncludeStatement = (
  line: string
): IncludeStatement | null => {
  const match = INCLUDE_STATEMENT.exec(line);
  if (!match?.groups) {
    return null;
  }
  const attributes: IncludeAttributes = {};
  for (const attr of (match.groups.attrs ?? "").matchAll(INCLUDE_ATTRIBUTE)) {
    const name = attr.groups?.name;
    const value = attr.groups?.double ?? attr.groups?.single;
    if (name === "lang" && value) {
      attributes.lang = value;
    }
    if (name === "meta" && value) {
      attributes.meta = value;
    }
    if (name && name !== "lang" && name !== "meta" && value !== undefined) {
      attributes.props = { ...attributes.props, [name]: value };
    }
  }
  return { attributes, target: match.groups.target ?? "" };
};

/**
 * Parse one raw `.md` source line as an include statement, applying the
 * line-level rules the renderer sees: a line indented like code (4 spaces or
 * a tab) is an indented code block, shown literally rather than spliced. The
 * render plugin's `.md` visitors share this so the two halves can't drift.
 */
export const parseIncludeLine = (line: string): IncludeStatement | null =>
  INDENTED_CODE.test(line) ? null : parseIncludeStatement(line.trim());

/** A line that opens an include statement: `<include`, then a space, `>`, or its end. */
const INCLUDE_OPEN = /^<include(?:[\s>]|$)/u;

/** A line that closes one. */
const INCLUDE_CLOSE = /<\/include\s*>$/u;

/**
 * How many lines a wrapped statement may span: room for a formatter that puts
 * every attribute on its own line, short enough that an unclosed `<include`
 * can't reach across a page.
 */
const MAX_STATEMENT_LINES = 8;

/** What a line that may open an include statement turned out to be. */
export type IncludeMatch =
  /** A statement, ending on line `end` (the same line when it isn't wrapped). */
  | { kind: "statement"; end: number; statement: IncludeStatement }
  /** A line that opens `<include` but no statement Blume can read. */
  | { kind: "malformed" }
  /** Not an include statement at all. */
  | { kind: "none" };

/**
 * Read the include statement opening at `lines[index]`, if any. A statement
 * sits on a line of its own, or — as a formatter wraps a long one — runs from a
 * line opening `<include` to the next line closing `</include>`, with no blank
 * line between (the path on its own line, attributes on one line or several):
 *
 * ```mdx
 * <include lang="ts" meta='title="config.ts"'>
 *   ./examples/config.ts
 * </include>
 * ```
 *
 * The lines' trimmed text joins into the one-line form, so both parse by the
 * same rules. In `.md` a first line indented like code is a code block, never
 * a statement. A line that opens `<include` but doesn't close into a
 * statement is `malformed`, so the author hears about it instead of the page
 * rendering the raw tag. Shared by the string-level scanner and the render
 * plugin so they splice exactly the same statements.
 */
export const matchIncludeStatement = (
  lines: readonly string[],
  index: number,
  format: "md" | "mdx"
): IncludeMatch => {
  const first = lines[index] ?? "";
  if (format === "md" && INDENTED_CODE.test(first)) {
    return { kind: "none" };
  }
  const opening = first.trim();
  if (!INCLUDE_OPEN.test(opening)) {
    return { kind: "none" };
  }
  const single = parseIncludeStatement(opening);
  if (single) {
    return { end: index, kind: "statement", statement: single };
  }
  const parts = [opening];
  const last = Math.min(lines.length, index + MAX_STATEMENT_LINES) - 1;
  for (let end = index + 1; end <= last; end += 1) {
    const part = (lines[end] ?? "").trim();
    if (part === "") {
      break;
    }
    parts.push(part);
    if (INCLUDE_CLOSE.test(part)) {
      const statement = parseIncludeStatement(parts.join(" "));
      return statement
        ? { end, kind: "statement", statement }
        : { kind: "malformed" };
    }
  }
  return { kind: "malformed" };
};

/**
 * The warning for a line that opens `<include` but isn't a statement Blume can
 * read — it renders as written, so a silent miss would ship a raw tag.
 */
export const malformedIncludeDiagnostic = (
  file: string,
  line: number
): Diagnostic => ({
  code: "BLUME_INCLUDE_MALFORMED",
  file,
  line,
  message:
    "This <include> isn't a statement Blume can read, so the page shows it as written.",
  severity: "warning",
  suggestion:
    'Write <include>./path.mdx</include> on a line of its own, or wrap it with the path on its own line and no blank lines. Attributes take lowercase names and quoted values (plan="Pro"): lang and meta shape a code include, and any other is a prop the included file reads as {{name}}.',
});

/**
 * Advance the HTML comment state across one `.md` line — the render plugin's
 * half of the comment rule (a statement inside `<!-- -->` never splices),
 * sharing the same tracking the string-level scanner uses.
 */
export const advanceHtmlCommentState = (
  line: string,
  inComment: boolean
): boolean => advanceCommentState(line, COMMENT_DELIMITERS.md, inComment);

/** Provenance of one line of expanded output. */
export interface LineOrigin {
  /** Absolute path of the file the line came from. */
  file: string;
  /** 1-based line number within that file's raw source. */
  line: number;
}

/** The result of expanding a document's include statements. */
export interface IncludeExpansion {
  /** The document with every include statement replaced by its content. */
  text: string;
  /** Per output line: the source file and raw-file line it came from. */
  origins: LineOrigin[];
  /** Absolute paths of every file included, transitively. */
  includes: string[];
  /** Structured errors (missing target, cycle, escape); statements with an
   * error stay verbatim in the output. */
  errors: Diagnostic[];
}

interface ExpandContext {
  /** The owning source's content root; bounds resolution when set. */
  contentRoot?: string;
  includes: Set<string>;
  errors: Diagnostic[];
}

const DOCS_SUGGESTION =
  "Include paths resolve relative to the including file; paths starting with / resolve from the content root.";

const includeError = (
  code: string,
  message: string,
  file: string,
  line: number,
  suggestion: string
): Diagnostic => ({ code, file, line, message, severity: "error", suggestion });

/**
 * Whether `path` lies outside `root`. The relative path must be `..` itself or
 * start with a `../` *segment* — a bare `.startsWith("..")` would also reject
 * a legal in-root directory whose name begins with two dots (`..archive/`).
 */
const escapesRoot = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith("../");
};

/**
 * Resolve a statement's target to an absolute path, or an error when it can't
 * be resolved safely. `/`-leading targets resolve from the content root;
 * everything else resolves from the including file's directory. Targets must
 * stay within the content root — a partial outside it would be silently
 * dropped from version snapshots and ejects (and an escaping path could
 * splice arbitrary files into published pages). Both branches enforce the
 * bound: a root-relative target can still climb out through `..` segments.
 */
const resolveIncludePath = (
  target: string,
  filePath: string,
  ctx: ExpandContext,
  line: number
): { path: string } | { error: Diagnostic } => {
  if (target.startsWith("/")) {
    if (!ctx.contentRoot) {
      return {
        error: includeError(
          "BLUME_INCLUDE_OUTSIDE_ROOT",
          `Include target ${target} is root-relative, but no content root is configured here.`,
          filePath,
          line,
          "Use a path relative to the including file instead."
        ),
      };
    }
    const path = join(ctx.contentRoot, target);
    if (escapesRoot(ctx.contentRoot, path)) {
      return {
        error: includeError(
          "BLUME_INCLUDE_OUTSIDE_ROOT",
          `Include target ${target} resolves outside the content root.`,
          filePath,
          line,
          "Root-relative include paths resolve from the content root and cannot climb above it."
        ),
      };
    }
    return { path };
  }
  const path = resolve(dirname(filePath), target);
  if (ctx.contentRoot && escapesRoot(ctx.contentRoot, path)) {
    return {
      error: includeError(
        "BLUME_INCLUDE_OUTSIDE_ROOT",
        `Include target ${target} resolves outside the content root.`,
        filePath,
        line,
        "Move the included file under the content root so builds, version snapshots, and ejects all see it."
      ),
    };
  }
  return { path };
};

/**
 * Rewrite one line's relative image targets from the included file's
 * directory to the including file's, so a partial's colocated
 * `![](./diagram.png)` still resolves once its markdown lives in the
 * includer. Mirrors `rewriteLine` in `content-assets.ts`: matches run on an
 * inline-code-masked copy while replacements splice into the real line.
 */
const rebaseImageLine = (
  line: string,
  fromDir: string,
  toDir: string
): string => {
  const masked = line.replaceAll(INLINE_CODE, (span) =>
    " ".repeat(span.length)
  );
  let out = "";
  let cursor = 0;
  for (const match of masked.matchAll(MD_IMAGE)) {
    const target = match.groups?.target ?? "";
    // Only filesystem-relative targets move with the file: URLs, public-dir
    // absolutes, and anchors mean the same thing from either directory.
    if (
      target.startsWith("/") ||
      target.startsWith("#") ||
      URL.canParse(target)
    ) {
      continue;
    }
    const rebased = relative(toDir, resolve(fromDir, target));
    const url = rebased.startsWith(".") ? rebased : `./${rebased}`;
    const offset =
      (match.index ?? 0) +
      targetOffsetIn(match[0], target, match.groups?.title);
    out += line.slice(cursor, offset) + url;
    cursor = offset + target.length;
  }
  return out + line.slice(cursor);
};

/** Rebase every relative image target in expanded lines, skipping fences. */
const rebaseImages = (
  lines: string[],
  fromDir: string,
  toDir: string
): string[] => {
  if (fromDir === toDir) {
    return lines;
  }
  let fence: FenceState = null;
  return lines.map((line) => {
    const next = nextFenceState(line, fence);
    const inFence = fence !== null || next !== null;
    fence = next;
    return inFence ? line : rebaseImageLine(line, fromDir, toDir);
  });
};

/** Wrap raw file content as a fenced code block that can't be broken by the
 * content's own backtick runs. */
const codeBlockLines = (
  content: string,
  path: string,
  attributes: IncludeAttributes
): string[] => {
  const body = content.replace(/\n$/u, "");
  let longestRun = 0;
  for (const run of body.match(/`+/gu) ?? []) {
    longestRun = Math.max(longestRun, run.length);
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const ext = extname(path);
  const lang = attributes.lang ?? (ext ? ext.slice(1) : "text");
  const meta = attributes.meta ? ` ${attributes.meta}` : "";
  return [`${fence}${lang}${meta}`, ...body.split("\n"), fence];
};

/** Lines-with-origins pair every splice step produces. */
interface ExpandedLines {
  lines: string[];
  origins: LineOrigin[];
}

/**
 * Resolve one include statement to its expanded lines. Content targets are
 * front-matter-stripped, recursively expanded, and image-rebased into the
 * includer's directory; code targets are fence-wrapped verbatim.
 */
const expandStatement = async (
  statement: IncludeStatement,
  filePath: string,
  line: number,
  ctx: ExpandContext,
  stack: readonly string[]
): Promise<ExpandedLines | { error: Diagnostic }> => {
  const resolved = resolveIncludePath(statement.target, filePath, ctx, line);
  if ("error" in resolved) {
    return resolved;
  }
  const { path } = resolved;
  if (stack.includes(path)) {
    return {
      error: includeError(
        "BLUME_INCLUDE_CYCLE",
        `Circular include: ${[...stack, path]
          .map((entry) => relative(ctx.contentRoot ?? dirname(path), entry))
          .join(" -> ")}.`,
        filePath,
        line,
        "Remove the include statement that closes the loop."
      ),
    };
  }
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (error) {
    return {
      error: includeError(
        "BLUME_INCLUDE_NOT_FOUND",
        `Include target ${statement.target} was not found (looked at ${path}): ${
          error instanceof Error ? error.message : String(error)
        }.`,
        filePath,
        line,
        DOCS_SUGGESTION
      ),
    };
  }
  ctx.includes.add(path);

  const asContent =
    !statement.attributes.lang &&
    CONTENT_EXTENSIONS.has(extname(path).toLowerCase());
  if (!asContent) {
    const lines = codeBlockLines(content, path, statement.attributes);
    // Fence delimiters are synthetic; anchor them (and the verbatim body,
    // which link extraction skips as fenced code anyway) to the target file.
    return {
      lines,
      origins: lines.map((_, i) => ({ file: path, line: Math.max(1, i) })),
    };
  }

  const parsed = matter(content);
  const body = parsed.content;
  const strippedOffset = Math.max(
    0,
    content.split("\n").length - body.split("\n").length
  );
  // The stack is copied per branch (never mutated) so sibling statements can
  // expand concurrently without seeing each other's frames as cycles.
  // oxlint-disable-next-line no-use-before-define -- mutual recursion: a partial expands its own includes
  const expanded = await expandLines(body, path, strippedOffset, ctx, [
    ...stack,
    path,
  ]);
  // Blank edge lines (the file's trailing newline, cosmetic leading gaps)
  // carry no markdown meaning; trimming them keeps splices tight and the
  // padding in `expandLines` the only blank-line authority.
  const lines = [...expanded.lines];
  const origins = [...expanded.origins];
  while (lines.at(-1)?.trim() === "") {
    lines.pop();
    origins.pop();
  }
  while (lines[0]?.trim() === "") {
    lines.shift();
    origins.shift();
  }
  // Props replace their `{{name}}` references line by line, so every line
  // keeps its origin; they reach the file's own nested includes too.
  const { props } = statement.attributes;
  return {
    lines: rebaseImages(
      props ? lines.map((text) => substituteVariables(text, props)) : lines,
      dirname(path),
      dirname(filePath)
    ),
    origins,
  };
};

/**
 * Pass 1 of {@link expandLines}: find each include statement (outside fenced
 * code, comments, and — in `.md` — indented code blocks), indexed by the line
 * it opens on. A commented-out statement never renders, so expanding it would
 * leak the partial into search/mirror surfaces the page doesn't show.
 * Indented code and setext underlines only exist in `.md` (MDX has neither,
 * and an indented `<include>` there is still JSX flow the renderer splices).
 */
const scanStatements = (
  sourceLines: string[],
  isMdx: boolean
): (IncludeMatch | null)[] => {
  const delimiters = COMMENT_DELIMITERS[isMdx ? "mdx" : "md"];
  const format = isMdx ? "mdx" : "md";
  const matches: (IncludeMatch | null)[] = sourceLines.map(() => null);
  let fence: FenceState = null;
  let inComment = false;
  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index] ?? "";
    if (inComment) {
      inComment = advanceCommentState(line, delimiters, true);
      continue;
    }
    const next = nextFenceState(line, fence);
    const inFence = fence !== null || next !== null;
    fence = next;
    if (inFence) {
      continue;
    }
    inComment = advanceCommentState(line, delimiters, false);
    if (inComment || !hasIncludeStatements(line)) {
      continue;
    }
    const match = matchIncludeStatement(sourceLines, index, format);
    // A setext underline directly below folds the statement into a heading —
    // the renderer shows a heading, not a splice, so skip it.
    if (
      match.kind === "statement" &&
      !isMdx &&
      SETEXT_UNDERLINE.test(sourceLines[match.end + 1] ?? "")
    ) {
      continue;
    }
    matches[index] = match;
    if (match.kind === "statement") {
      // A wrapped statement's remaining lines belong to it.
      index = match.end;
    }
  }
  return matches;
};

/**
 * Walk a document's lines, replacing each include statement (outside fenced
 * code, comments, and — in `.md` — indented code blocks) with the target's
 * expanded lines. Statements that error stay verbatim so downstream surfaces
 * show what the author wrote; a blank line is padded around each splice so a
 * partial can't merge into an adjacent paragraph.
 */
const expandLines = async (
  body: string,
  filePath: string,
  lineOffset: number,
  ctx: ExpandContext,
  stack: readonly string[]
): Promise<ExpandedLines> => {
  const sourceLines = body.split("\n");
  const isMdx = extname(filePath).toLowerCase() === ".mdx";
  const matches = scanStatements(sourceLines, isMdx);

  // Pass 2: expand every statement concurrently — reads are independent, and
  // each branch carries its own cycle stack.
  const expansions = await Promise.all(
    matches.map((match, index) =>
      match?.kind === "statement"
        ? expandStatement(
            match.statement,
            filePath,
            lineOffset + index + 1,
            ctx,
            stack
          )
        : null
    )
  );

  // Pass 3: assemble sequentially — the blank-line padding depends on the
  // accumulated output, and error order should follow document order.
  const lines: string[] = [];
  const origins: LineOrigin[] = [];
  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index] ?? "";
    const rawLine = lineOffset + index + 1;
    const match = matches[index];
    const expanded = expansions[index];
    if (match?.kind === "malformed") {
      ctx.errors.push(malformedIncludeDiagnostic(filePath, rawLine));
    }
    if (!expanded || "error" in expanded) {
      if (expanded) {
        ctx.errors.push(expanded.error);
      }
      lines.push(line);
      origins.push({ file: filePath, line: rawLine });
      continue;
    }
    const pad = (): void => {
      lines.push("");
      origins.push({ file: filePath, line: rawLine });
    };
    if (lines.at(-1)?.trim()) {
      pad();
    }
    lines.push(...expanded.lines);
    origins.push(...expanded.origins);
    // A wrapped statement's remaining lines were spliced with it.
    if (match?.kind === "statement") {
      index = match.end;
    }
    if (sourceLines[index + 1]?.trim()) {
      pad();
    }
  }
  return { lines, origins };
};

/**
 * Expand a document's include statements at the string level. `lineOffset`
 * shifts the includer's own recorded origin lines — pass the stripped front
 * matter block's height when `body` is the stripped text, so origins point at
 * real file lines. Never throws: unresolvable statements stay verbatim and
 * surface through `errors`.
 */
export const expandIncludes = async (
  body: string,
  options: {
    /** Absolute path of the file being expanded. */
    sourcePath: string;
    /** The owning source's content root; bounds include resolution. */
    contentRoot?: string;
    /** Raw-file line of `body`'s first line, minus one (default `0`). */
    lineOffset?: number;
  }
): Promise<IncludeExpansion> => {
  const ctx: ExpandContext = {
    contentRoot: options.contentRoot,
    errors: [],
    includes: new Set(),
  };
  const { lines, origins } = await expandLines(
    body,
    options.sourcePath,
    options.lineOffset ?? 0,
    ctx,
    [options.sourcePath]
  );
  return {
    errors: ctx.errors,
    includes: [...ctx.includes],
    origins,
    text: lines.join("\n"),
  };
};

/**
 * Resolve one include statement to its fully-expanded markdown text — the
 * render plugin's entry point (it finds the statements as AST nodes and only
 * needs each target spliced). Shares every semantic with
 * {@link expandIncludes}.
 */
export const expandIncludeTarget = async (
  statement: IncludeStatement,
  options: { sourcePath: string; contentRoot?: string }
): Promise<{ text: string; errors: Diagnostic[] } | { error: Diagnostic }> => {
  const ctx: ExpandContext = {
    contentRoot: options.contentRoot,
    errors: [],
    includes: new Set(),
  };
  const expanded = await expandStatement(
    statement,
    options.sourcePath,
    0,
    ctx,
    [options.sourcePath]
  );
  if ("error" in expanded) {
    return { error: expanded.error };
  }
  // Nested statements that errored stay verbatim inside the splice (matching
  // the string-level surfaces); they're reported so the render can warn.
  return { errors: ctx.errors, text: expanded.lines.join("\n") };
};

/**
 * Invert the scan's page → included-partials edges into the partial →
 * including-pages map `includeHmrPlugin` reads (`generated/includes.json`),
 * so editing a partial invalidates every page that splices it. Localized
 * pages share a source path, hence the dedupe. Shared by `generateRuntime`
 * and `eject`, whose configs both wire the plugin at the same path.
 */
export const buildIncludeGraph = (
  pages: { sourcePath?: string; includes?: string[] }[]
) => {
  const graph: Record<string, string[]> = {};
  for (const page of pages) {
    const { sourcePath } = page;
    if (!sourcePath) {
      continue;
    }
    for (const partial of page.includes ?? []) {
      const includers = graph[partial] ?? [];
      graph[partial] = includers;
      if (!includers.includes(sourcePath)) {
        includers.push(sourcePath);
      }
    }
  }
  return graph;
};

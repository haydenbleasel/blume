import { colors } from "consola/utils";
import { relative } from "pathe";
import type { ZodError } from "zod";

import type { Diagnostic } from "./types.ts";

/** A recoverable error carrying a structured diagnostic. */
export class BlumeError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = "BlumeError";
    this.diagnostic = diagnostic;
  }
}

export const createDiagnostic = (diagnostic: Diagnostic): Diagnostic =>
  diagnostic;

/** Docs site base; diagnostic help links resolve against it. */
const DOCS_BASE = "https://useblume.dev";

const DOCS_DEPLOYMENT = "/docs/deployment";
const DOCS_CLI_VALIDATE = "/docs/cli/validate";
const DOCS_CONTENT_SOURCES = "/docs/content/sources";
const DOCS_CONTENT_NAVIGATION = "/docs/content/navigation";
const DOCS_CONTENT_INCLUDES = "/docs/content/includes";

/** Diagnostic code → the docs page that explains it. */
const DOCS_PATHS = new Map(
  Object.entries({
    BLUME_ADAPTER_REQUIRED: DOCS_DEPLOYMENT,
    BLUME_ASSETS_UNCHECKED: DOCS_CLI_VALIDATE,
    BLUME_ASSET_FETCH_FAILED: DOCS_CONTENT_SOURCES,
    BLUME_BROKEN_ANCHOR: DOCS_CLI_VALIDATE,
    BLUME_BROKEN_ASSET: DOCS_CLI_VALIDATE,
    BLUME_BROKEN_LINK: DOCS_CLI_VALIDATE,
    BLUME_COMPONENTS_INVALID: "/docs/configuration/customization",
    BLUME_CONFIG_INVALID: "/docs/configuration",
    BLUME_CONFIG_LOAD_FAILED: "/docs/configuration",
    BLUME_CONTENT_ROOT_MISSING: DOCS_CONTENT_SOURCES,
    BLUME_DEAD_LINK: DOCS_CLI_VALIDATE,
    BLUME_DEPENDENCY_MISSING: "/docs/cli/doctor",
    BLUME_DUPLICATE_ROUTE: DOCS_CONTENT_NAVIGATION,
    BLUME_DUPLICATE_SIDEBAR_ORDER: DOCS_CONTENT_NAVIGATION,
    BLUME_FRONTMATTER_INVALID: "/docs/content/frontmatter",
    BLUME_INCLUDE_CYCLE: DOCS_CONTENT_INCLUDES,
    BLUME_INCLUDE_MALFORMED: DOCS_CONTENT_INCLUDES,
    BLUME_INCLUDE_NOT_FOUND: DOCS_CONTENT_INCLUDES,
    BLUME_INCLUDE_OUTSIDE_ROOT: DOCS_CONTENT_INCLUDES,
    BLUME_MDX_CURLY_ANCHOR: "/docs/content/syntax",

    BLUME_META_INVALID: "/docs/content/meta",
    BLUME_META_LOAD_FAILED: "/docs/content/meta",
    BLUME_MISSING_SECRET: DOCS_DEPLOYMENT,
    BLUME_NAV_DUPLICATE_LABEL: DOCS_CONTENT_NAVIGATION,
    BLUME_NAV_HIDDEN_IN_SIDEBAR: DOCS_CONTENT_NAVIGATION,
    BLUME_NAV_INDEX_TITLE_MISMATCH: DOCS_CONTENT_NAVIGATION,
    BLUME_NAV_MISSING_PAGE: DOCS_CONTENT_NAVIGATION,
    BLUME_NODE_VERSION: "/docs/quickstart",
    BLUME_SERVER_FEATURE_REQUIRED: DOCS_DEPLOYMENT,
    BLUME_SIDEBAR_DISPLAY_IGNORED: DOCS_CONTENT_NAVIGATION,
    BLUME_SOURCE_FETCH_FAILED: DOCS_CONTENT_SOURCES,
    BLUME_SOURCE_MISCONFIGURED: DOCS_CONTENT_SOURCES,
    BLUME_SOURCE_OFFLINE: DOCS_CONTENT_SOURCES,
    BLUME_SOURCE_SDK_MISSING: DOCS_CONTENT_SOURCES,
    BLUME_SOURCE_UNAVAILABLE: DOCS_CONTENT_SOURCES,
    BLUME_TRANSLATE_MISSING: "/docs/cli/translate",
    BLUME_TRANSLATE_STALE: "/docs/cli/translate",
    BLUME_UNKNOWN_COMPONENT: "/docs/configuration/customization",
    BLUME_UNKNOWN_DIRECTIVE: "/docs/content/syntax",
    BLUME_UNKNOWN_ICON: DOCS_CONTENT_NAVIGATION,
    BLUME_UNKNOWN_OPTION: "/docs/cli",
    BLUME_UNLOADABLE_FILE_NAME: "/docs/content",
    BLUME_WIKILINK_AMBIGUOUS: DOCS_CONTENT_SOURCES,
    BLUME_WIKILINK_UNRESOLVED: DOCS_CONTENT_SOURCES,
    BLUME_YARN_PNP: "/docs/quickstart",
  })
);

/** The docs URL that explains a diagnostic code, if one is mapped. */
export const resolveDocsUrl = (code: string): string | undefined => {
  const path = DOCS_PATHS.get(code);
  return path ? `${DOCS_BASE}${path}` : undefined;
};

/** Fill in `docsUrl` from the code map where a diagnostic doesn't set its own. */
export const enrichDiagnostic = (diagnostic: Diagnostic): Diagnostic =>
  diagnostic.docsUrl
    ? diagnostic
    : { ...diagnostic, docsUrl: resolveDocsUrl(diagnostic.code) };

const REGEXP_SPECIAL = /[$()*+.?[\\\]^{|}]/gu;
const escapeRegExp = (value: string): string =>
  value.replaceAll(REGEXP_SPECIAL, String.raw`\$&`);

/** A key segment scans the source text; an array index has no key to find. */
const isKeySegment = (segment: string | number): segment is string =>
  typeof segment === "string";

/**
 * Where a located value's children are searched. `object` and `array` are the
 * inside of a `{…}`/`[…]` literal, searched entry by entry so a key or an index
 * only matches a direct child. `block` has no brackets — the whole file at the
 * top, or a YAML key's indented lines — and is searched at any depth.
 */
interface Scope {
  end: number;
  /** A literal's direct entries (keys or elements), in source order. */
  entries: number[];
  kind: "array" | "block" | "object";
  start: number;
}

/** A located key or element: where it starts, and where its value starts. */
interface Step {
  index: number;
  next: number;
}

const QUOTES = new Set(['"', "'", "`"]);
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const WHITESPACE = /\s/u;

/**
 * The index just past a comment starting at `index`, or `index` when none does.
 * A `//` after a `:` is a URL scheme in YAML (`href: https://…`), not a comment.
 */
const skipComment = (source: string, index: number): number => {
  if (source.startsWith("//", index) && source.charAt(index - 1) !== ":") {
    const end = source.indexOf("\n", index);
    return end === -1 ? source.length : end;
  }
  if (source.startsWith("/*", index)) {
    const end = source.indexOf("*/", index + 2);
    return end === -1 ? source.length : end + 2;
  }
  return index;
};

/**
 * The index just past a string literal starting at `index`, or `index` when
 * none does. A `'`/`"` that doesn't close on its own line is an apostrophe in
 * plain YAML text, not a string.
 */
const skipString = (source: string, index: number): number => {
  const quote = source.charAt(index);
  if (!QUOTES.has(quote)) {
    return index;
  }
  let cursor = index + 1;
  while (cursor < source.length) {
    const char = source.charAt(cursor);
    if (char === quote) {
      return cursor + 1;
    }
    if (char === "\n" && quote !== "`") {
      return index;
    }
    cursor += char === "\\" ? 2 : 1;
  }
  return index;
};

/** Where a literal closes, and where each of its direct entries starts. */
interface LiteralScan {
  end: number;
  entries: number[];
}

/**
 * Walk the `{…}`/`[…]` literal opened at `open`: where each direct entry starts
 * (a key, or an array element) and where the literal closes. Nested brackets,
 * strings, and comments are stepped over, so only the literal's own commas
 * separate its entries.
 */
const scanLiteral = (source: string, open: number): LiteralScan => {
  const entries: number[] = [];
  let depth = 0;
  let pending = true;
  let index = open + 1;
  while (index < source.length) {
    const afterComment = skipComment(source, index);
    const char = source.charAt(index);
    if (afterComment !== index || WHITESPACE.test(char)) {
      index = Math.max(afterComment, index + 1);
      continue;
    }
    if (depth === 0 && CLOSERS.has(char)) {
      return { end: index, entries };
    }
    if (depth === 0 && pending) {
      entries.push(index);
      pending = false;
    }
    const afterString = skipString(source, index);
    if (afterString !== index) {
      index = afterString;
      continue;
    }
    if (OPENERS.has(char)) {
      depth += 1;
    } else if (CLOSERS.has(char)) {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      pending = true;
    }
    index += 1;
  }
  return { end: source.length, entries };
};

/**
 * The lines indented deeper than the key at `anchor` — a YAML mapping's
 * children — up to the first line that isn't, or `limit`.
 */
const indentedBlock = (
  source: string,
  anchor: number,
  limit: number
): Scope => {
  const column = anchor - (source.lastIndexOf("\n", anchor - 1) + 1);
  const lineEnd = source.indexOf("\n", anchor);
  const start = lineEnd === -1 ? limit : Math.min(lineEnd + 1, limit);
  let end = start;
  while (end < limit) {
    const next = source.indexOf("\n", end);
    const after = next === -1 || next >= limit ? limit : next + 1;
    const line = source.slice(end, after);
    if (line.trim() !== "" && line.length - line.trimStart().length <= column) {
      break;
    }
    end = after;
  }
  return { end, entries: [], kind: "block", start };
};

/** A value's lead-in before its literal: spaces, or an adapter call's `vercel(`. */
const VALUE_LEAD = /[\s\w$.(]*/uy;

/**
 * The scope holding the children of the key or element at `anchor`, whose
 * value starts at `from`. A `{…}`/`[…]` literal — written directly, or as the
 * first argument of a call like `vercel({…})` — is walked entry by entry;
 * anything else falls back to the lines indented under `anchor` (YAML's
 * nesting), within the enclosing scope's `limit`.
 */
const valueScope = (source: string, step: Step, limit: number): Scope => {
  VALUE_LEAD.lastIndex = step.next;
  VALUE_LEAD.exec(source);
  const open = VALUE_LEAD.lastIndex;
  const char = source.charAt(open);
  if (open < limit && (char === "{" || char === "[")) {
    const literal = scanLiteral(source, open);
    return {
      end: literal.end,
      entries: literal.entries,
      kind: char === "{" ? "object" : "array",
      start: open,
    };
  }
  return indentedBlock(source, step.index, limit);
};

/**
 * Find `segment` as a `key:`/`key =` (bare or quoted) in `scope`: among an
 * object literal's own entries, or anywhere in a block. The negative lookbehind
 * keeps `title` from matching the tail of an unrelated key such as `subtitle:`.
 */
const findKey = (
  source: string,
  scope: Scope,
  segment: string
): Step | undefined => {
  const key = escapeRegExp(segment);
  const pattern = `(?<![\\w$])(?:${key}|"${key}"|'${key}')\\s*[:=]`;
  if (scope.kind === "block") {
    const matcher = new RegExp(pattern, "gu");
    matcher.lastIndex = scope.start;
    const match = matcher.exec(source);
    return match && match.index < scope.end
      ? { index: match.index, next: matcher.lastIndex }
      : undefined;
  }
  // Sticky: the key must start exactly where the entry does.
  const matcher = new RegExp(pattern, "uy");
  for (const entry of scope.kind === "object" ? scope.entries : []) {
    matcher.lastIndex = entry;
    if (matcher.test(source)) {
      return { index: entry, next: matcher.lastIndex };
    }
  }
  return undefined;
};

/** The element at `position` of an array literal; a block can't be indexed. */
const findElement = (scope: Scope, position: number): Step | undefined => {
  const index = scope.kind === "array" ? scope.entries[position] : undefined;
  return index === undefined ? undefined : { index, next: index };
};

/**
 * Best-effort source position for a Zod issue path (e.g. `["seo", "title"]`,
 * `["redirects", 2, "status"]`) in the raw config / frontmatter text. Narrows
 * segment by segment: a key is found among its parent's own entries (or, where
 * there are no brackets, in the parent's indented lines), an index picks that
 * element of an array literal. A segment that isn't there — a missing key —
 * stops the walk at its parent, so the position never escapes into a sibling.
 * Returns 1-based line/column, or undefined when not even the first segment
 * matches.
 */
const locatePath = (
  source: string,
  path: readonly (string | number)[]
): { column: number; line: number } | undefined => {
  let scope: Scope = {
    end: source.length,
    entries: [],
    kind: "block",
    start: 0,
  };
  let found = -1;
  for (const segment of path) {
    const step = isKeySegment(segment)
      ? findKey(source, scope, segment)
      : findElement(scope, segment);
    if (!step) {
      break;
    }
    found = step.index;
    scope = valueScope(source, step, scope.end);
  }
  if (found < 0) {
    return;
  }
  const before = source.slice(0, found);
  const lastNewline = before.lastIndexOf("\n");
  return { column: found - lastNewline, line: before.split("\n").length };
};

/** The YAML front matter block of a `.md`/`.mdx` source, if it has one. */
const FRONTMATTER = /^---\r?\n(?<body>[\s\S]*?)\r?\n---/u;

/**
 * Locate a front matter key in a content file, e.g. `["seo", "description"]` in
 * `docs/api.mdx`. Scoped to the front matter block so a `title:` written in the
 * page body can't be mistaken for the front matter key of the same name; returns
 * undefined when the file has no front matter or the key isn't set (a missing
 * key has no line to point at — callers anchor to the file instead).
 */
export const locateFrontmatterKey = (
  source: string,
  path: readonly (string | number)[]
): { column: number; line: number } | undefined => {
  const block = FRONTMATTER.exec(source);
  if (!block) {
    return;
  }
  // `locatePath` reports lines 1-based within the text it was given, and the
  // front matter body starts one line below the opening `---`.
  const position = locatePath(block.groups?.body ?? "", path);
  return position && { column: position.column, line: position.line + 1 };
};

/**
 * Convert generic validation issues (message + path, the shape shared by Zod
 * and Standard Schema issues) into Blume diagnostics, anchored to a file.
 */
export const diagnosticsFromIssues = (
  issues: readonly {
    message: string;
    path: readonly (string | number)[];
  }[],
  options: { code: string; file?: string; source?: string }
): Diagnostic[] =>
  issues.map((issue) => {
    const schemaPath = issue.path.join(".");
    const position = options.source
      ? locatePath(options.source, issue.path)
      : undefined;
    return {
      code: options.code,
      column: position?.column,
      file: options.file,
      line: position?.line,
      message: schemaPath ? `${schemaPath}: ${issue.message}` : issue.message,
      schemaPath: schemaPath || undefined,
      severity: "error",
    } satisfies Diagnostic;
  });

/** Convert a ZodError into Blume diagnostics, anchored to a file. */
export const diagnosticsFromZod = (
  error: ZodError,
  options: { code: string; file?: string; source?: string }
): Diagnostic[] =>
  diagnosticsFromIssues(
    error.issues.map((issue) => ({
      message: issue.message,
      // Zod 4 paths are PropertyKey[]; a symbol segment has no place in a
      // dotted schema path or a source-position scan.
      path: issue.path.filter(
        (segment): segment is string | number => typeof segment !== "symbol"
      ),
    })),
    options
  );

const severityColor = (severity: Diagnostic["severity"]) => {
  if (severity === "error") {
    return colors.red;
  }
  if (severity === "warning") {
    return colors.yellow;
  }
  return colors.blue;
};

/** Format a single diagnostic for terminal output. */
export const formatDiagnostic = (
  diagnostic: Diagnostic,
  root?: string
): string => {
  const color = severityColor(diagnostic.severity);
  const lines: string[] = [
    `${color(colors.bold(diagnostic.code))} ${diagnostic.message}`,
  ];

  // An audit finding is about a built URL, and names the source file that fixes
  // it as a second line ("at /docs/api" / "in docs/api.mdx:3:2"). Everything
  // else is about a file alone, and keeps the original single `at file` line.
  if (diagnostic.url) {
    lines.push(`  ${colors.dim(`at ${diagnostic.url}`)}`);
  }
  if (diagnostic.file) {
    const location = root ? relative(root, diagnostic.file) : diagnostic.file;
    const column =
      diagnostic.column === undefined ? "" : `:${diagnostic.column}`;
    const position =
      diagnostic.line === undefined ? "" : `:${diagnostic.line}${column}`;
    const label = diagnostic.url ? "in" : "at";
    lines.push(`  ${colors.dim(`${label} ${location}${position}`)}`);
  }

  if (diagnostic.suggestion) {
    lines.push(`  ${colors.cyan(`fix: ${diagnostic.suggestion}`)}`);
  }

  if (diagnostic.docsUrl) {
    lines.push(`  ${colors.dim(`docs: ${diagnostic.docsUrl}`)}`);
  }

  return lines.join("\n");
};

export const hasErrors = (diagnostics: Diagnostic[]): boolean =>
  diagnostics.some((d) => d.severity === "error");

export const countBySeverity = (diagnostics: Diagnostic[]) => {
  const counts = { error: 0, info: 0, warning: 0 } satisfies Record<
    Diagnostic["severity"],
    number
  >;
  for (const diagnostic of diagnostics) {
    counts[diagnostic.severity] += 1;
  }
  return counts;
};

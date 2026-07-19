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
const DOCS_REFERENCE_CLI = "/docs/reference/cli";
const DOCS_CONTENT_SOURCES = "/docs/content/sources";
const DOCS_CONTENT_NAVIGATION = "/docs/content/navigation";

/** Diagnostic code → the docs page that explains it. */
const DOCS_PATHS: Record<string, string> = {
  BLUME_ADAPTER_REQUIRED: DOCS_DEPLOYMENT,
  BLUME_ASSETS_UNCHECKED: DOCS_REFERENCE_CLI,
  BLUME_ASSET_FETCH_FAILED: DOCS_CONTENT_SOURCES,
  BLUME_BROKEN_ANCHOR: DOCS_REFERENCE_CLI,
  BLUME_BROKEN_ASSET: DOCS_REFERENCE_CLI,
  BLUME_BROKEN_LINK: DOCS_REFERENCE_CLI,
  BLUME_CONFIG_INVALID: "/docs/configuration",
  BLUME_CONFIG_LOAD_FAILED: "/docs/configuration",
  BLUME_CONTENT_ROOT_MISSING: DOCS_CONTENT_SOURCES,
  BLUME_DEAD_LINK: DOCS_REFERENCE_CLI,
  BLUME_DUPLICATE_ROUTE: DOCS_CONTENT_NAVIGATION,
  BLUME_DUPLICATE_SIDEBAR_ORDER: DOCS_CONTENT_NAVIGATION,
  BLUME_FRONTMATTER_INVALID: "/docs/reference/frontmatter",
  BLUME_META_INVALID: "/docs/content/meta",
  BLUME_META_LOAD_FAILED: "/docs/content/meta",
  BLUME_MISSING_SECRET: DOCS_DEPLOYMENT,
  BLUME_NAV_DUPLICATE_LABEL: DOCS_CONTENT_NAVIGATION,
  BLUME_NAV_HIDDEN_IN_SIDEBAR: DOCS_CONTENT_NAVIGATION,
  BLUME_NAV_MISSING_PAGE: DOCS_CONTENT_NAVIGATION,
  BLUME_NODE_VERSION: "/docs/quickstart",
  BLUME_SERVER_FEATURE_REQUIRED: DOCS_DEPLOYMENT,
  BLUME_SOURCE_FETCH_FAILED: DOCS_CONTENT_SOURCES,
  BLUME_SOURCE_MISCONFIGURED: DOCS_CONTENT_SOURCES,
  BLUME_SOURCE_OFFLINE: DOCS_CONTENT_SOURCES,
  BLUME_SOURCE_SDK_MISSING: DOCS_CONTENT_SOURCES,
  BLUME_SOURCE_UNAVAILABLE: DOCS_CONTENT_SOURCES,
  BLUME_UNKNOWN_COMPONENT: "/docs/configuration/customization",
  BLUME_UNKNOWN_ICON: DOCS_CONTENT_NAVIGATION,
};

/** The docs URL that explains a diagnostic code, if one is mapped. */
export const resolveDocsUrl = (code: string): string | undefined => {
  const path = DOCS_PATHS[code];
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

/**
 * Best-effort source position for a Zod issue path (e.g. `["seo", "title"]`) in
 * the raw config / frontmatter text. Narrows key-by-key — finding each string
 * segment as a `key:`/`key =` at or after the previous match — so a nested key
 * lands under its parent. Array indices are skipped. Returns 1-based line/column,
 * or undefined when nothing matches.
 */
const stepSegment = (
  source: string,
  segment: string | number,
  cursor: number
): { index: number; next: number; stop: boolean } => {
  // A non-string path segment (array index) is skipped without moving on.
  if (typeof segment !== "string") {
    return { index: -1, next: cursor, stop: false };
  }
  // The negative lookbehind keeps a segment like `title` from matching the
  // tail of an unrelated key such as `subtitle:`.
  const matcher = new RegExp(
    `(?<![\\w$])${escapeRegExp(segment)}\\s*[:=]`,
    "gu"
  );
  matcher.lastIndex = cursor;
  const match = matcher.exec(source);
  if (!match) {
    return { index: -1, next: cursor, stop: true };
  }
  return { index: match.index, next: matcher.lastIndex, stop: false };
};

const locatePath = (
  source: string,
  path: readonly (string | number)[]
): { column: number; line: number } | undefined => {
  let cursor = 0;
  let found = -1;
  for (const segment of path) {
    const step = stepSegment(source, segment, cursor);
    if (step.stop) {
      break;
    }
    cursor = step.next;
    if (step.index >= 0) {
      found = step.index;
    }
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
      message:
        "received" in issue
          ? `${issue.message} (received: ${JSON.stringify(issue.received)})`
          : issue.message,
      path: issue.path,
    })),
    options
  );

const ESC = String.fromCodePoint(27);
const COLORS = {
  blue: `${ESC}[34m`,
  bold: `${ESC}[1m`,
  cyan: `${ESC}[36m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  reset: `${ESC}[0m`,
  yellow: `${ESC}[33m`,
};

const severityColor = (severity: Diagnostic["severity"]): string => {
  if (severity === "error") {
    return COLORS.red;
  }
  if (severity === "warning") {
    return COLORS.yellow;
  }
  return COLORS.blue;
};

/** Format a single diagnostic for terminal output. */
export const formatDiagnostic = (
  diagnostic: Diagnostic,
  root?: string
): string => {
  const color = severityColor(diagnostic.severity);
  const lines: string[] = [
    `${color}${COLORS.bold}${diagnostic.code}${COLORS.reset} ${diagnostic.message}`,
  ];

  // An audit finding is about a built URL, and names the source file that fixes
  // it as a second line ("at /docs/api" / "in docs/api.mdx:3:2"). Everything
  // else is about a file alone, and keeps the original single `at file` line.
  if (diagnostic.url) {
    lines.push(`  ${COLORS.dim}at ${diagnostic.url}${COLORS.reset}`);
  }
  if (diagnostic.file) {
    const location = root ? relative(root, diagnostic.file) : diagnostic.file;
    const column =
      diagnostic.column === undefined ? "" : `:${diagnostic.column}`;
    const position =
      diagnostic.line === undefined ? "" : `:${diagnostic.line}${column}`;
    const label = diagnostic.url ? "in" : "at";
    lines.push(`  ${COLORS.dim}${label} ${location}${position}${COLORS.reset}`);
  }

  if (diagnostic.suggestion) {
    lines.push(`  ${COLORS.cyan}fix: ${diagnostic.suggestion}${COLORS.reset}`);
  }

  if (diagnostic.docsUrl) {
    lines.push(`  ${COLORS.dim}docs: ${diagnostic.docsUrl}${COLORS.reset}`);
  }

  return lines.join("\n");
};

export const hasErrors = (diagnostics: Diagnostic[]): boolean =>
  diagnostics.some((d) => d.severity === "error");

export const countBySeverity = (
  diagnostics: Diagnostic[]
): Record<Diagnostic["severity"], number> => {
  const counts = { error: 0, info: 0, warning: 0 };
  for (const diagnostic of diagnostics) {
    counts[diagnostic.severity] += 1;
  }
  return counts;
};

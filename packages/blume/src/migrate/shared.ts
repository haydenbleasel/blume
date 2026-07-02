import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import { isAbsolute, join, relative } from "pathe";

import type { BlumeConfig } from "../core/schema.ts";
import { pageMetaSchema } from "../core/schema.ts";

/**
 * Whether `candidate` resolves to a path inside `root` (or is `root` itself).
 * Guards migrators against `../` traversal in author-controlled source paths
 * (`pages` entries, `<include>` targets) that would otherwise read or move
 * files outside the docs tree.
 */
export const isInsideRoot = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Framework-agnostic helpers shared by more than one migrator. Each piece here
 * was generalized from a migrator-specific implementation so Mintlify, Nextra,
 * and future migrators converge on a single copy.
 */

/** Serialize a `BlumeConfig` to a `blume.config.ts` at the project root. */
export const writeBlumeConfig = async (
  root: string,
  config: BlumeConfig
): Promise<void> => {
  const body = `import { defineConfig } from "blume";\n\nexport default defineConfig(${JSON.stringify(config, null, 2)});\n`;
  await writeFile(join(root, "blume.config.ts"), body, "utf-8");
};

// ---------------------------------------------------------------------------
// Old-framework teardown
// ---------------------------------------------------------------------------

/** The Blume command each standard npm script maps to after a migration. */
const BLUME_SCRIPTS: Record<string, string> = {
  build: "blume build",
  dev: "blume dev",
  start: "blume preview",
};

/**
 * Rewrite a migrated project's npm scripts off the old framework's CLI. A
 * `dev`/`build`/`start` script whose command invokes `cli` (e.g. `/\bnext\b/`)
 * is repointed at the matching Blume command (`start` -> `blume preview`); a
 * script whose command matches `remove` (e.g. a `fumadocs-mdx` postinstall) is
 * dropped. Scripts that don't match either are left untouched, so custom tasks
 * survive. Returns true when `package.json` changed.
 */
export const rewriteFrameworkScripts = async (
  root: string,
  cli: RegExp,
  remove?: RegExp
): Promise<boolean> => {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    return false;
  }
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
  } catch {
    return false;
  }
  const { scripts } = pkg;
  if (!scripts || typeof scripts !== "object") {
    return false;
  }

  const next: Record<string, unknown> = {};
  let changed = false;
  for (const [name, command] of Object.entries(scripts)) {
    const blume = BLUME_SCRIPTS[name];
    if (typeof command === "string" && remove?.test(command)) {
      changed = true;
    } else if (
      typeof command === "string" &&
      blume &&
      cli.test(command) &&
      command !== blume
    ) {
      next[name] = blume;
      changed = true;
    } else {
      next[name] = command;
    }
  }

  if (changed) {
    pkg.scripts = next;
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
  }
  return changed;
};

/** A `.gitignore` line, normalized for comparison (trailing slashes dropped). */
const gitignoreKey = (line: string): string => line.trim().replace(/\/+$/u, "");

/**
 * Ensure `.gitignore` ignores each of `entries`, appending any that are missing
 * (creating the file when absent). Trailing-slash differences (`dist` vs
 * `dist/`) count as already present. Returns the entries actually added.
 */
export const ensureGitignore = async (
  root: string,
  entries: string[]
): Promise<string[]> => {
  const path = join(root, ".gitignore");
  const existing = existsSync(path) ? await readFile(path, "utf-8") : "";
  const present = new Set(
    existing.split("\n").map(gitignoreKey).filter(Boolean)
  );
  const added = entries.filter((entry) => !present.has(gitignoreKey(entry)));
  if (added.length === 0) {
    return [];
  }
  const gap = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(path, `${existing}${gap}${added.join("\n")}\n`, "utf-8");
  return added;
};

/** Of the candidate project-relative paths, the ones that still exist — the old
 * framework files a migration leaves behind for the user to remove by hand. */
export const leftoverFiles = (root: string, candidates: string[]): string[] =>
  candidates.filter((candidate) => existsSync(join(root, candidate)));

// ---------------------------------------------------------------------------
// Callout components -> Blume `:::` directives
// ---------------------------------------------------------------------------

export interface CalloutRewriteOptions {
  /** Directive for a type-bearing tag with no `type` attribute (e.g. bare `<Callout>`). */
  defaultDirective: string;
  /** Tag names whose directive is fixed by the tag itself (e.g. `<Warning>`). */
  tagDirectives: Record<string, string>;
  /** Component tag names to convert. */
  tags: string[];
  /** `type="…"` values mapped to Blume directive names. */
  typeDirectives: Record<string, string>;
}

/** Read a quoted string attribute (`name="…"` or `name='…'`) from a tag. */
export const attribute = (attrs: string, name: string): string | undefined => {
  const match = attrs.match(
    new RegExp(`\\b${name}=(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)')`, "u")
  );
  return match?.groups?.dq ?? match?.groups?.sq;
};

/** Remove a shared leading indent and surrounding blank lines from a block. */
const dedent = (value: string): string => {
  const lines = value
    .replace(/^\r?\n/u, "")
    .replace(/\s+$/u, "")
    .split("\n");
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.match(/^\s*/u)?.[0].length ?? 0);
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(common)).join("\n");
};

const directiveBlock = (
  directive: string,
  title: string | undefined,
  inner: string
): string => {
  const head = title ? `:::${directive}[${title}]` : `:::${directive}`;
  const body = dedent(inner);
  return `${head}\n${body}\n:::`;
};

/**
 * Find the `>` that closes an opening JSX tag, honoring quotes and `{…}`
 * expression attributes (so a `>` inside `icon={"<svg…>"}` is not mistaken for
 * the tag end). Returns -1 if unterminated.
 */
export const findOpenTagEnd = (source: string, from: number): number => {
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    } else if (char === ">" && depth === 0) {
      return index;
    }
  }
  return -1;
};

const directiveFor = (
  tag: string,
  attrs: string,
  options: CalloutRewriteOptions
): string | undefined => {
  if (tag in options.tagDirectives) {
    return options.tagDirectives[tag];
  }
  const type = attribute(attrs, "type")?.toLowerCase();
  return type ? options.typeDirectives[type] : options.defaultDirective;
};

/**
 * Convert callout-style JSX components into Blume `:::` directives. Uses a
 * quote/brace-aware tag scanner so callouts carrying JSX-expression attributes
 * (e.g. inline-SVG icons) convert cleanly; non-convertible attributes (icons,
 * colors, emoji) are dropped. A tag whose resolved directive is unknown is left
 * untouched.
 */
export const rewriteCallouts = (
  source: string,
  options: CalloutRewriteOptions
): string => {
  const tagPattern = new RegExp(
    `<(?<tag>${options.tags.join("|")})(?=[\\s/>])`,
    "u"
  );
  let output = "";
  let cursor = 0;

  while (cursor < source.length) {
    const match = tagPattern.exec(source.slice(cursor));
    if (!match?.groups) {
      output += source.slice(cursor);
      break;
    }

    const start = cursor + match.index;
    const { tag } = match.groups;
    if (!tag) {
      output += source.slice(cursor);
      break;
    }
    const openEnd = findOpenTagEnd(source, start + tag.length + 1);
    if (openEnd === -1) {
      output += source.slice(cursor, start + 1);
      cursor = start + 1;
      continue;
    }

    const attrs = source.slice(start + tag.length + 1, openEnd);
    const directive = directiveFor(tag, attrs, options);
    const closeTag = `</${tag}>`;
    const selfClosing = attrs.trimEnd().endsWith("/");
    const closeIndex = selfClosing
      ? openEnd
      : source.indexOf(closeTag, openEnd + 1);

    if (!directive || (!selfClosing && closeIndex === -1)) {
      output += source.slice(cursor, openEnd + 1);
      cursor = openEnd + 1;
      continue;
    }

    output += source.slice(cursor, start);
    const title = attribute(attrs, "title");
    if (selfClosing) {
      output += title
        ? `:::${directive}[${title}]\n:::`
        : `:::${directive}\n:::`;
      cursor = openEnd + 1;
    } else {
      output += directiveBlock(
        directive,
        title,
        source.slice(openEnd + 1, closeIndex)
      );
      cursor = closeIndex + closeTag.length;
    }
  }

  return output;
};

// ---------------------------------------------------------------------------
// Page frontmatter
// ---------------------------------------------------------------------------

/**
 * Remove frontmatter keys Blume's strict page schema would reject (e.g. stray
 * `og:*`/`twitter:*` metatags) so the migrated page validates, reporting what
 * was dropped. Validation errors other than stray keys are left for `blume dev`
 * to surface.
 */
export const stripUnknownPageMeta = (
  data: Record<string, unknown>
): { data: Record<string, unknown>; removed: string[] } => {
  const result = pageMetaSchema.safeParse(data);
  if (result.success) {
    return { data, removed: [] };
  }

  const removed = new Set<string>();
  for (const issue of result.error.issues) {
    if (issue.code === "unrecognized_keys" && issue.path.length === 0) {
      for (const key of issue.keys) {
        removed.add(key);
      }
    }
  }
  if (removed.size === 0) {
    return { data, removed: [] };
  }

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!removed.has(key)) {
      next[key] = value;
    }
  }
  return { data: next, removed: [...removed] };
};

// ---------------------------------------------------------------------------
// JSX tag renaming
// ---------------------------------------------------------------------------

/**
 * Rename a JSX tag (open and close) while preserving its attributes. The
 * trailing lookahead means a longer tag (e.g. `CardGrid`) is never matched by a
 * rule for its shorter prefix (`Card`), so prefix-sharing renames can be chained
 * — run the item-level rename before the container rename.
 */
export const renameTag = (source: string, from: string, to: string): string =>
  source.replaceAll(
    new RegExp(`<(?<close>/?)${from}(?=[\\s/>])`, "gu"),
    `<$<close>${to}`
  );

// ---------------------------------------------------------------------------
// JavaScript literal scanning
// ---------------------------------------------------------------------------

/**
 * Static readers for JS/TS config files (Nextra `_meta`, Starlight
 * `astro.config`). Config is parsed by walking the source as text — quote-,
 * comment-, and bracket-aware — rather than executing user code, matching the
 * other migrators (which never eval). Values that aren't pure literals (an
 * identifier, call, JSX, or interpolated template) are reported as `UNPARSEABLE`
 * so the caller can drop the field and warn.
 */

/** Index of a string within a JS source: the close quote matching `s[open]`. */
export const findStringEnd = (s: string, open: number): number => {
  const quote = s[open];
  for (let index = open + 1; index < s.length; index += 1) {
    if (s[index] === "\\") {
      index += 1;
      continue;
    }
    if (s[index] === quote) {
      return index;
    }
  }
  return -1;
};

export const unescapeString = (inner: string): string =>
  inner.replaceAll(/\\(?<ch>["'`\\nt])/gu, (_match, ch: string) => {
    if (ch === "n") {
      return "\n";
    }
    if (ch === "t") {
      return "\t";
    }
    return ch;
  });

/** Index of the last char of a `//` or block comment at `index`, else `index`. */
const skipComment = (source: string, index: number): number => {
  if (source[index + 1] === "/") {
    const newline = source.indexOf("\n", index + 2);
    return newline === -1 ? source.length : newline;
  }
  if (source[index + 1] === "*") {
    const close = source.indexOf("*/", index + 2);
    return close === -1 ? source.length : close + 1;
  }
  return index;
};

const pushSlice = (
  parts: string[],
  source: string,
  start: number,
  end: number
): void => {
  const raw = source.slice(start, end).trim();
  if (raw) {
    parts.push(raw);
  }
};

export interface ObjectScanResult {
  end: number;
  entries: string[];
}

/**
 * Walk a `{…}` object literal starting at `openIndex`, returning the matching
 * close-brace index and the raw `key: value` text of each top-level entry.
 * Quote-, comment-, and bracket-aware so commas/braces nested in strings,
 * arrays, or child objects don't split entries. Returns null if unterminated.
 */
export const scanObject = (
  source: string,
  openIndex: number
): ObjectScanResult | null => {
  let depth = 0;
  const entries: string[] = [];
  let entryStart = openIndex + 1;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(source, index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/") {
      const skipped = skipComment(source, index);
      if (skipped !== index) {
        index = skipped;
        continue;
      }
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (char === "}" && depth === 0) {
        pushSlice(entries, source, entryStart, index);
        return { end: index, entries };
      }
      continue;
    }
    if (char === "," && depth === 1) {
      pushSlice(entries, source, entryStart, index);
      entryStart = index + 1;
    }
  }

  return null;
};

export interface ArrayScanResult {
  elements: string[];
  end: number;
}

/**
 * Walk a `[…]` array literal starting at `openIndex`, returning the matching
 * close-bracket index and the raw text of each top-level element. The sibling of
 * {@link scanObject}; a trailing comma yields no empty element.
 */
export const scanArray = (
  source: string,
  openIndex: number
): ArrayScanResult | null => {
  let depth = 0;
  const elements: string[] = [];
  let elementStart = openIndex + 1;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(source, index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/") {
      const skipped = skipComment(source, index);
      if (skipped !== index) {
        index = skipped;
        continue;
      }
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === ")") {
      depth -= 1;
      continue;
    }
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        pushSlice(elements, source, elementStart, index);
        return { elements, end: index };
      }
      continue;
    }
    if (char === "," && depth === 1) {
      pushSlice(elements, source, elementStart, index);
      elementStart = index + 1;
    }
  }

  return null;
};

/**
 * Strip `//` and block comments so they don't leak into entry text (the scanner
 * splits on slices, so an inter-entry comment would otherwise attach to the next
 * entry). String literals are preserved verbatim.
 */
export const stripJsComments = (source: string): string => {
  let out = "";
  let quote: string | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += source[index + 1] ?? "";
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index + 2);
      index = newline === -1 ? source.length - 1 : newline - 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close === -1 ? source.length - 1 : close + 1;
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
};

export interface KeyValue {
  key: string;
  value: string;
}

/** Split a raw `key: value` entry at its top-level colon. */
export const splitKeyValue = (entry: string): KeyValue | null => {
  let index = 0;
  while (index < entry.length && /\s/u.test(entry[index] ?? "")) {
    index += 1;
  }
  const first = entry[index];
  if (first === "[") {
    // Computed key — not something we can resolve statically.
    return null;
  }

  let key: string;
  if (first === '"' || first === "'" || first === "`") {
    const close = findStringEnd(entry, index);
    if (close === -1) {
      return null;
    }
    key = entry.slice(index, close + 1);
    index = close + 1;
  } else {
    const start = index;
    while (index < entry.length && !/[\s:]/u.test(entry[index] ?? "")) {
      index += 1;
    }
    key = entry.slice(start, index);
  }

  while (index < entry.length && /\s/u.test(entry[index] ?? "")) {
    index += 1;
  }
  if (entry[index] !== ":") {
    return { key, value: "" };
  }
  return { key, value: entry.slice(index + 1).trim() };
};

/** Read an object key, unquoting it when it is a string literal. */
export const parseKey = (key: string): string => {
  const trimmed = key.trim();
  const [quote] = trimmed;
  if (quote === '"' || quote === "'" || quote === "`") {
    const end = findStringEnd(trimmed, 0);
    if (end !== -1) {
      return unescapeString(trimmed.slice(1, end));
    }
  }
  return trimmed;
};

/** Read a clean string literal value, or null if it's an expression. */
export const readString = (value: string): string | null => {
  const trimmed = value.trim();
  const [quote] = trimmed;
  if (quote !== '"' && quote !== "'" && quote !== "`") {
    return null;
  }
  if (quote === "`" && trimmed.includes("${")) {
    return null;
  }
  const end = findStringEnd(trimmed, 0);
  if (end === -1 || trimmed.slice(end + 1).trim() !== "") {
    return null;
  }
  return unescapeString(trimmed.slice(1, end));
};

/** A value that isn't a pure literal (identifier, call, JSX, computed, …). */
export const UNPARSEABLE = Symbol("unparseable");

export type LiteralValue =
  | LiteralValue[]
  | boolean
  | null
  | number
  | string
  | typeof UNPARSEABLE
  | { [key: string]: LiteralValue };

const NUMERIC = /^-?\d/u;

const parseScalarLiteral = (trimmed: string): LiteralValue => {
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  if (NUMERIC.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isNaN(num)) {
      return num;
    }
  }
  return UNPARSEABLE;
};

const parseObjectLiteral = (trimmed: string): LiteralValue => {
  const scan = scanObject(trimmed, 0);
  if (!scan || trimmed.slice(scan.end + 1).trim() !== "") {
    return UNPARSEABLE;
  }
  const out: Record<string, LiteralValue> = {};
  for (const entry of scan.entries) {
    const kv = splitKeyValue(entry);
    if (kv?.key && kv.value !== "") {
      // oxlint-disable-next-line no-use-before-define -- mutual recursion
      out[parseKey(kv.key)] = parseLiteral(kv.value);
    }
  }
  return out;
};

const parseArrayLiteral = (trimmed: string): LiteralValue => {
  const scan = scanArray(trimmed, 0);
  if (!scan || trimmed.slice(scan.end + 1).trim() !== "") {
    return UNPARSEABLE;
  }
  // oxlint-disable-next-line no-use-before-define -- mutual recursion
  return scan.elements.map((element) => parseLiteral(element));
};

/**
 * Evaluate a JS literal expression (string / number / boolean / null / array /
 * object) into its value without executing it. Anything else resolves to
 * {@link UNPARSEABLE}; inside arrays the sentinel keeps the element's position,
 * inside objects it stays as the field's value so the caller can warn and drop.
 */
export const parseLiteral = (source: string): LiteralValue => {
  const trimmed = source.trim();
  if (trimmed === "") {
    return UNPARSEABLE;
  }
  const [first] = trimmed;
  if (first === '"' || first === "'" || first === "`") {
    return readString(trimmed) ?? UNPARSEABLE;
  }
  if (first === "{") {
    return parseObjectLiteral(trimmed);
  }
  if (first === "[") {
    return parseArrayLiteral(trimmed);
  }
  return parseScalarLiteral(trimmed);
};

/** Narrow a parsed literal to a string. */
export const asLiteralString = (
  value: LiteralValue | undefined
): string | undefined => (typeof value === "string" ? value : undefined);

/** Narrow a parsed literal to a plain object (not an array or `UNPARSEABLE`). */
export const isLiteralObject = (
  value: LiteralValue | undefined
): value is Record<string, LiteralValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Narrow a parsed literal to an array. */
export const asLiteralArray = (
  value: LiteralValue | undefined
): LiteralValue[] | undefined => (Array.isArray(value) ? value : undefined);

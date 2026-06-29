import { existsSync } from "node:fs";
import { readFile as readFileFromDisk } from "node:fs/promises";

import matter from "gray-matter";
import { dirname, resolve } from "pathe";

import { findOpenTagEnd, rewriteCallouts } from "../shared.ts";

/**
 * Source-to-source rewrites that turn Fumadocs-only MDX into idiomatic Blume
 * markup. Runs once at migration time — no Fumadocs-aware plugins remain in the
 * Blume runtime.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const FUMADOCS_IMPORT =
  /^import\s+[\s\S]*?\s+from\s+["']fumadocs-(?:ui|core|mdx)(?:\/[^"']*)?["'];?[ \t]*\n?/gmu;

/**
 * Drop `import … from "fumadocs-ui/…"` (and `-core`/`-mdx`) statements. Blume
 * injects its components globally, so these imports would fail to resolve once
 * the Fumadocs packages are gone.
 */
export const stripFumadocsImports = (source: string): string => {
  const stripped = source.replace(FUMADOCS_IMPORT, "");
  // Collapse the blank gap a removed import block leaves behind.
  return stripped === source ? source : stripped.replaceAll(/\n{3,}/gu, "\n\n");
};

// ---------------------------------------------------------------------------
// Callouts
// ---------------------------------------------------------------------------

/** Fumadocs `<Callout type="X">` values mapped to Blume directive names. */
const CALLOUT_TYPE_DIRECTIVES: Record<string, string> = {
  error: "danger",
  info: "info",
  note: "note",
  success: "success",
  tip: "tip",
  warn: "warning",
  warning: "warning",
};

/**
 * Convert Fumadocs `<Callout type="info|warn|error|…" title="…">` components
 * into Blume `:::` directives. A bare `<Callout>` becomes `:::note`; the `icon`
 * prop is dropped.
 */
export const rewriteFumadocsCallouts = (source: string): string =>
  rewriteCallouts(source, {
    defaultDirective: "note",
    tagDirectives: {},
    tags: ["Callout"],
    typeDirectives: CALLOUT_TYPE_DIRECTIVES,
  });

// ---------------------------------------------------------------------------
// Container component renames
// ---------------------------------------------------------------------------

/** Rename a JSX tag (open and close) while preserving its attributes. */
const renameTag = (source: string, from: string, to: string): string =>
  source.replaceAll(
    new RegExp(`<(?<close>/?)${from}(?=[\\s/>])`, "gu"),
    `<$<close>${to}`
  );

/**
 * Rename Fumadocs container components to their Blume equivalents. The
 * lookahead in `renameTag` means a longer tag (`Accordions`, `Files`) is never
 * matched by the rule for its shorter prefix (`Accordion`, `File`), so the
 * item-level renames run first and the container renames second:
 *
 * - `<Cards>` -> `<CardGroup>` (items stay `<Card>`).
 * - `<Accordions>`/`<Accordion>` -> `<Accordion>`/`<AccordionItem>`.
 * - `<Files>`/`<Folder>`/`<File>` -> `<FileTree>`/`<TreeFolder>`/`<TreeFile>`.
 */
export const rewriteFumadocsContainers = (source: string): string => {
  let out = renameTag(source, "Cards", "CardGroup");
  out = renameTag(out, "Accordion", "AccordionItem");
  out = renameTag(out, "Accordions", "Accordion");
  out = renameTag(out, "File", "TreeFile");
  out = renameTag(out, "Folder", "TreeFolder");
  out = renameTag(out, "Files", "FileTree");
  return out;
};

// ---------------------------------------------------------------------------
// Tabs (items + value -> per-Tab title)
// ---------------------------------------------------------------------------

const TABS_TAG = /<Tabs(?=[\s/>])/u;
const TAB_TAG = /<Tab(?=[\s/>])/u;
const ITEM_LITERAL = /'(?<s>[^']*)'|"(?<d>[^"]*)"|`(?<t>[^`]*)`/gu;

const escapeAttribute = (value: string): string =>
  value.replaceAll('"', "&quot;");

/** Find the close brace matching the `{` at `open`, or -1 if unterminated. */
const matchBrace = (source: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
};

/** Span of an `items={…}` expression within a tag's attributes, or null. */
const itemsSpan = (attrs: string): { end: number; start: number } | null => {
  const match = /\bitems\s*=\s*/u.exec(attrs);
  if (!match) {
    return null;
  }
  const braceStart = attrs.indexOf("{", match.index + match[0].length);
  if (braceStart === -1) {
    return null;
  }
  const braceEnd = matchBrace(attrs, braceStart);
  return braceEnd === -1 ? null : { end: braceEnd, start: match.index };
};

/** Read the string literals from a Fumadocs `<Tabs items={[…]}>` attribute. */
const parseItems = (attrs: string): string[] => {
  const span = itemsSpan(attrs);
  if (!span) {
    return [];
  }
  const inner = attrs.slice(span.start, span.end + 1);
  const items: string[] = [];
  for (const match of inner.matchAll(ITEM_LITERAL)) {
    items.push(match.groups?.s ?? match.groups?.d ?? match.groups?.t ?? "");
  }
  return items;
};

/** Rebuild a `<Tabs …>` open tag with the `items={…}` attribute removed. */
const buildTabsOpen = (attrs: string, selfClosing: boolean): string => {
  const span = itemsSpan(attrs);
  const withoutItems = span
    ? attrs.slice(0, span.start) + attrs.slice(span.end + 1)
    : attrs;
  const body = withoutItems.replace(/\/\s*$/u, "").trim();
  const space = body ? ` ${body}` : "";
  return selfClosing ? `<Tabs${space} />` : `<Tabs${space}>`;
};

/** Give a single `<Tab …>` open tag a `title`, preferring its own `value`. */
const titleizeTab = (tag: string, fallback: string | undefined): string => {
  if (/\btitle\s*=/u.test(tag)) {
    return tag;
  }
  if (/\bvalue\s*=/u.test(tag)) {
    return tag.replace(/\bvalue(?<eq>\s*=)/u, "title$<eq>");
  }
  if (fallback === undefined) {
    return tag;
  }
  return tag.replace(/^<Tab/u, `<Tab title="${escapeAttribute(fallback)}"`);
};

/**
 * Find the `</name>` that closes the tag opened at `from` (an index just past
 * the open tag's `>`), honoring nesting. Returns its start index, or -1.
 */
const findMatchingClose = (
  source: string,
  from: number,
  name: string
): number => {
  const token = new RegExp(`<${name}(?=[\\s/>])|</${name}>`, "gu");
  token.lastIndex = from;
  let depth = 1;
  for (let match = token.exec(source); match; match = token.exec(source)) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) {
        return match.index;
      }
    } else {
      depth += 1;
    }
  }
  return -1;
};

/** Title the direct `<Tab>` children of a Tabs block, skipping nested Tabs. */
const titleizeTabChildren = (inner: string, items: string[]): string => {
  let output = "";
  let cursor = 0;
  let position = 0;

  while (cursor < inner.length) {
    const rest = inner.slice(cursor);
    const tab = TAB_TAG.exec(rest);
    if (!tab) {
      output += rest;
      break;
    }
    const nested = TABS_TAG.exec(rest);
    if (nested && nested.index < tab.index) {
      const start = cursor + nested.index;
      const openEnd = findOpenTagEnd(inner, start + "<Tabs".length);
      const close =
        openEnd === -1 ? -1 : findMatchingClose(inner, openEnd + 1, "Tabs");
      if (close === -1) {
        output += inner.slice(cursor);
        break;
      }
      const end = close + "</Tabs>".length;
      output += inner.slice(cursor, end);
      cursor = end;
      continue;
    }
    const start = cursor + tab.index;
    const openEnd = findOpenTagEnd(inner, start + "<Tab".length);
    if (openEnd === -1) {
      output += inner.slice(cursor, start + 1);
      cursor = start + 1;
      continue;
    }
    const tagText = inner.slice(start, openEnd + 1);
    output +=
      inner.slice(cursor, start) + titleizeTab(tagText, items[position]);
    position += 1;
    cursor = openEnd + 1;
  }

  return output;
};

/**
 * Reshape Fumadocs tabs to Blume's API. Fumadocs declares tab labels on the
 * parent (`<Tabs items={['npm','pnpm']}>`) and selects with `<Tab value="npm">`;
 * Blume's `<Tab>` carries its own `title`. Each tab is titled from its `value`
 * (or the positional `items` entry) and the `items` prop is stripped. Nested
 * tab groups are handled recursively with their own `items`.
 */
export const rewriteFumadocsTabs = (source: string): string => {
  let output = "";
  let cursor = 0;

  while (cursor < source.length) {
    const match = TABS_TAG.exec(source.slice(cursor));
    if (!match) {
      output += source.slice(cursor);
      break;
    }
    const start = cursor + match.index;
    const openEnd = findOpenTagEnd(source, start + "<Tabs".length);
    if (openEnd === -1) {
      output += source.slice(cursor, start + 1);
      cursor = start + 1;
      continue;
    }
    const attrs = source.slice(start + "<Tabs".length, openEnd);
    const selfClosing = attrs.trimEnd().endsWith("/");
    output += source.slice(cursor, start);

    if (selfClosing) {
      output += buildTabsOpen(attrs, true);
      cursor = openEnd + 1;
      continue;
    }

    const close = findMatchingClose(source, openEnd + 1, "Tabs");
    if (close === -1) {
      output += source.slice(start, openEnd + 1);
      cursor = openEnd + 1;
      continue;
    }
    const inner = rewriteFumadocsTabs(source.slice(openEnd + 1, close));
    output += buildTabsOpen(attrs, false);
    output += titleizeTabChildren(inner, parseItems(attrs));
    output += "</Tabs>";
    cursor = close + "</Tabs>".length;
  }

  return output;
};

// ---------------------------------------------------------------------------
// Includes
// ---------------------------------------------------------------------------

const INCLUDE = /<include\b[^>]*>(?<path>[\s\S]*?)<\/include>/gu;

interface IncludeOptions {
  filePath: string;
  readFile?: (file: string) => Promise<string>;
  seen?: Set<string>;
}

/**
 * Inline Fumadocs `<include>./partial.mdx</include>` references — source-level
 * includes with no Blume runtime equivalent. The referenced file's frontmatter
 * is stripped, nested includes are resolved (with a cycle guard), and the path
 * is resolved relative to the including file. Missing or circular targets are
 * left untouched and reported.
 */
export const inlineFumadocsIncludes = async (
  source: string,
  options: IncludeOptions
): Promise<{ content: string; warnings: string[] }> => {
  const matches = [...source.matchAll(INCLUDE)];
  if (matches.length === 0) {
    return { content: source, warnings: [] };
  }

  const read = options.readFile ?? ((file) => readFileFromDisk(file, "utf-8"));
  const seen = options.seen ?? new Set<string>();
  const warnings: string[] = [];
  let content = source;

  for (const match of matches) {
    const rawPath = match.groups?.path?.trim() ?? "";
    if (!rawPath) {
      continue;
    }
    const target = resolve(dirname(options.filePath), rawPath);
    if (seen.has(target)) {
      warnings.push(`Circular <include> "${rawPath}" — left as-is.`);
      continue;
    }
    if (!existsSync(target)) {
      warnings.push(`<include> target "${rawPath}" not found — left as-is.`);
      continue;
    }
    seen.add(target);
    // oxlint-disable-next-line no-await-in-loop -- sequential include reads
    const raw = await read(target);
    // oxlint-disable-next-line no-await-in-loop -- sequential include reads
    const nested = await inlineFumadocsIncludes(matter(raw).content.trim(), {
      ...options,
      filePath: target,
      seen,
    });
    seen.delete(target);
    warnings.push(...nested.warnings);
    content = content.replace(match[0], () => nested.content);
  }

  return { content, warnings };
};

// ---------------------------------------------------------------------------
// Unsupported components
// ---------------------------------------------------------------------------

/** Fumadocs components with no drop-in Blume equivalent — flagged for review. */
const UNSUPPORTED_COMPONENTS = [
  "Banner",
  "DynamicCodeBlock",
  "ImageZoom",
  "InlineTOC",
];

/** Names of Fumadocs components in `source` that need manual attention. */
export const unsupportedFumadocsComponents = (source: string): string[] =>
  UNSUPPORTED_COMPONENTS.filter((name) =>
    new RegExp(`<${name}\\b`, "u").test(source)
  );

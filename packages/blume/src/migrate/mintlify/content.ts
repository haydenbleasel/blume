import { dirname, join, relative } from "pathe";

/**
 * Source-to-source rewrites that turn Mintlify-only MDX component syntax into
 * idiomatic Blume markup. Runs once at migration time — no Mintlify-aware
 * plugins remain in the Blume runtime.
 */

/** Mintlify callout components mapped to Blume directive names. */
const CALLOUT_DIRECTIVES: Record<string, string> = {
  Check: "success",
  Danger: "danger",
  Error: "danger",
  Info: "info",
  Note: "note",
  Success: "success",
  Tip: "tip",
  Warning: "warning",
};

/** `<Callout type="X">` values mapped to Blume directive names. */
const CALLOUT_TYPE_DIRECTIVES: Record<string, string> = {
  caution: "warning",
  check: "success",
  danger: "danger",
  error: "danger",
  info: "info",
  note: "note",
  success: "success",
  tip: "tip",
  warning: "warning",
};

const attribute = (attrs: string, name: string): string | undefined => {
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

const CALLOUT_TAG =
  /<(?<tag>Callout|Check|Danger|Error|Info|Note|Success|Tip|Warning)(?=[\s/>])/u;

/**
 * Find the `>` that closes an opening JSX tag, honoring quotes and `{…}`
 * expression attributes (so a `>` inside `icon={"<svg…>"}` is not mistaken for
 * the tag end). Returns -1 if unterminated.
 */
const findOpenTagEnd = (source: string, from: number): number => {
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

const directiveFor = (tag: string, attrs: string): string | undefined => {
  if (tag !== "Callout") {
    return CALLOUT_DIRECTIVES[tag];
  }
  const type = attribute(attrs, "type")?.toLowerCase();
  return type ? CALLOUT_TYPE_DIRECTIVES[type] : "note";
};

/**
 * Convert Mintlify callout components (`<Note>`, `<Warning>`, `<Callout
 * type="…">`, …) into Blume `:::` directives. Uses a quote/brace-aware tag
 * scanner so callouts with JSX-expression attributes (e.g. inline-SVG icons)
 * convert cleanly. Non-convertible attributes (icons, colors) are dropped.
 */
export const rewriteMintlifyCallouts = (source: string): string => {
  let output = "";
  let cursor = 0;

  while (cursor < source.length) {
    const match = CALLOUT_TAG.exec(source.slice(cursor));
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
    const directive = directiveFor(tag, attrs);
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

/**
 * Mintlify's `<RequestExample>`/`<ResponseExample>` are tab-style code wrappers
 * with no Blume equivalent; rename them to `<CodeGroup>`, which renders the
 * same titled-fence tabs.
 */
export const rewriteMintlifyExampleBlocks = (source: string): string =>
  source.replaceAll(
    /<(?<close>\/?)(?:Request|Response)Example\b/gu,
    "<$<close>CodeGroup"
  );

const SNIPPET_IMPORT =
  /^import\s+[\s\S]*?\s+from\s+["'](?<source>\/snippets\/[^"']+)["'];?[ \t]*\n?/gmu;

/**
 * After snippets are inlined, clean up leftover `/snippets/*` imports: drop the
 * now-dead markdown imports, and rewrite component imports (`.jsx`/`.tsx`/…) to
 * a path relative to the page so they still resolve once `/snippets` content is
 * gone. Returns the rewritten source and the component files still referenced.
 */
export const rewriteSnippetImports = (
  source: string,
  options: { filePath: string; root: string }
): { components: string[]; source: string } => {
  const components: string[] = [];
  const next = source.replaceAll(
    SNIPPET_IMPORT,
    (match, importSource: string) => {
      if (/\.mdx?$/u.test(importSource)) {
        return "";
      }
      const target = join(options.root, importSource.replace(/^\/+/u, ""));
      components.push(importSource.replace(/^\/+/u, ""));
      let rel = relative(dirname(options.filePath), target);
      if (!rel.startsWith(".")) {
        rel = `./${rel}`;
      }
      return match.replace(importSource, rel);
    }
  );
  return { components, source: next };
};

/** Component tags Blume has no equivalent for — reported for manual review. */
const UNSUPPORTED_COMPONENTS = ["ParamField", "ResponseField"];

/** Names of Mintlify components in `source` that need manual attention. */
export const unsupportedMintlifyComponents = (source: string): string[] =>
  UNSUPPORTED_COMPONENTS.filter((name) =>
    new RegExp(`<${name}\\b`, "u").test(source)
  );

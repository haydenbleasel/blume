import { writeFile } from "node:fs/promises";

import { join } from "pathe";

import type { BlumeConfig } from "../core/schema.ts";
import { pageMetaSchema } from "../core/schema.ts";

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

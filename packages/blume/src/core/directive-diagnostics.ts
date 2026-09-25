import type { Nodes } from "mdast";
import { mdxToMdast } from "satteri";

import {
  CALLOUT_ALIASES,
  CALLOUT_TYPES,
  calloutTypeFor,
} from "../markdown/directives.ts";
import { MDX_BODY_FEATURES } from "../markdown/features.ts";
import { strippedLineOffset } from "./sources/normalize.ts";
import type { SourceEntry } from "./sources/types.ts";
import type { Diagnostic } from "./types.ts";

// A line that may open a container directive: a colon fence and a name, after
// any quote or list indentation. A page is parsed only when one of these
// names something other than a callout, so pages without one cost a scan.
const CONTAINER_OPENING = /^[\t >]*:{3,}(?<name>[a-z][\w-]*)/gimu;

const codeList = (names: Iterable<string>): string =>
  [...names].map((name) => `\`${name}\``).join(", ");

const CALLOUT_NAMES = `${codeList(CALLOUT_TYPES)} (or the aliases ${codeList(Object.keys(CALLOUT_ALIASES))})`;

/** A container directive that isn't a callout, and its line in `text`. */
interface UnknownContainer {
  line: number;
  name: string;
}

/**
 * Every container directive in an `.mdx` body whose name isn't a callout, in
 * source order. The body is parsed as the renderer reads it, so a fence in a
 * code block or a `::: name` that isn't a directive at all never counts. A
 * body MDX can't parse fails to render anyway, with its own error.
 */
const unknownContainers = (text: string): UnknownContainer[] => {
  const named = [...text.matchAll(CONTAINER_OPENING)].some(
    (match) => calloutTypeFor(match.groups?.name ?? "") === null
  );
  if (!named) {
    return [];
  }
  let tree: Nodes;
  try {
    tree = mdxToMdast(text, { features: MDX_BODY_FEATURES });
  } catch {
    return [];
  }
  const found: UnknownContainer[] = [];
  const walk = (node: Nodes): void => {
    if (
      node.type === "containerDirective" &&
      calloutTypeFor(node.name) === null
    ) {
      found.push({ line: node.position?.start.line ?? 1, name: node.name });
    }
    if ("children" in node) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  walk(tree);
  return found;
};

/**
 * Warn about each `:::name` container in an `.mdx` entry that isn't a callout.
 * The page keeps its content — the body renders between the literal `:::`
 * lines (see `markdown/directives.ts`) — but a typo like `:::warnig`, or a
 * `:::details` carried over from another docs tool, should read as the
 * mistake it is rather than as a finished page. Lines point into the file
 * the author wrote, a partial's own file for a container an `<include>`
 * brought in.
 */
export const unknownDirectiveDiagnostics = (
  entry: SourceEntry,
  sourceName: string
): Diagnostic[] => {
  if (entry.body.format !== "mdx") {
    return [];
  }
  const page = entry.sourcePath ?? `${sourceName}:${entry.ref}`;
  const offset =
    entry.bodyLineOffset ?? strippedLineOffset(entry.raw, entry.body.text);
  return unknownContainers(entry.expanded?.text ?? entry.body.text).map(
    ({ line, name }) => {
      const origin = entry.expanded?.origins[line - 1];
      return {
        code: "BLUME_UNKNOWN_DIRECTIVE",
        file: origin?.file ?? page,
        line: origin?.line ?? line + offset,
        message: `\`:::${name}\` isn't a callout type, so the page shows its \`:::\` lines as written around its content.`,
        severity: "warning",
        suggestion: `Use a callout type — ${CALLOUT_NAMES} — or remove the \`:::\` lines to keep the content as plain prose.`,
      };
    }
  );
};

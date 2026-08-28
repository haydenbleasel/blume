import { fileURLToPath } from "node:url";

import { resolve } from "pathe";

import type { IncludeStatement } from "../core/includes.ts";
import {
  advanceHtmlCommentState,
  expandIncludeTarget,
  hasIncludeStatements,
  parseIncludeLine,
} from "../core/includes.ts";
import type { MdastNode, MdastValue } from "./mdast.ts";

/**
 * Sätteri MDAST plugin for `<include>` statements — the render half of
 * content includes (see `core/includes.ts` for the semantics and the
 * string-level half that powers search, llms.txt, and the `.md` mirrors).
 * Runs first in the plugin chain: mutations apply before the next plugin
 * visits, so callouts, mermaid, and math inside a spliced partial transform
 * exactly like inline content. Replacements use Sätteri's `{ raw }` escape
 * hatch, so the target is parsed in the including page's format.
 *
 * In `.mdx`, a lowercase `<include>` arrives as an `mdxJsxFlowElement`. In
 * plain `.md`, `<include>` isn't a known block-level HTML tag, so CommonMark
 * parses the statement line as a *paragraph* holding inline `html` nodes —
 * the paragraph visitor slices the statement back out of the source by
 * position. A statement swallowed into a block `html` node (adjacent to real
 * block HTML) is handled line-wise too. Statements must occupy their own
 * line — includes are block-level.
 */

/** The attribute slice of an `mdxJsxAttribute` node the plugin reads. The
 * index signature keeps the array assignable to `MdastNode`'s `MdastValue`
 * properties. */
interface JsxAttributeNode {
  [key: string]: MdastValue;
  type?: string;
  name?: string;
  value?: MdastValue;
}

/** The `mdxJsxFlowElement` slice the plugin reads. */
interface JsxFlowNode extends MdastNode {
  name?: string | null;
  attributes?: JsxAttributeNode[];
  position?: {
    start?: { line?: number };
    end?: { line?: number };
  };
}

/** The raw-HTML node slice (`.md` pages) the plugin reads. */
interface HtmlNode extends MdastNode {
  value: string;
}

/** The position slice used to recover a paragraph's raw source text. */
interface PositionedNode extends MdastNode {
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

/** The visitor-context slice the plugin uses (see `mdast.ts` for the model). */
interface IncludeVisitorContext {
  fileURL: URL | undefined;
  source: string;
  replaceNode: (node: MdastNode, replacement: { raw: string }) => void;
  textContent: (node: MdastNode) => string;
  report: (report: {
    message: string;
    node?: MdastNode;
    severity?: "error" | "warning" | "info";
  }) => void;
}

/** A visible stand-in for a statement that failed to resolve, so a broken
 * include can't silently render as nothing in dev. */
const errorBlock = (message: string): string =>
  `> **Include error:** ${message}`;

export interface IncludePluginOptions {
  /** The docs content root; bounds include resolution when set. */
  contentRoot?: string;
}

/** A plain string attribute value; expression values don't carry a path. */
const isStringValue = (value: MdastValue): value is string =>
  typeof value === "string";

const statementFromJsx = (
  node: JsxFlowNode,
  ctx: IncludeVisitorContext
): IncludeStatement => {
  const attributes: IncludeStatement["attributes"] = {};
  for (const attr of node.attributes ?? []) {
    if (attr.type !== "mdxJsxAttribute" || !isStringValue(attr.value)) {
      continue;
    }
    if (attr.name === "lang" && attr.value) {
      attributes.lang = attr.value;
    }
    if (attr.name === "meta" && attr.value) {
      attributes.meta = attr.value;
    }
  }
  return { attributes, target: ctx.textContent(node).trim() };
};

export const includePlugin = (options: IncludePluginOptions = {}) => {
  // An ejected config carries a project-relative content root ("docs"); the
  // generated `.blume` config an absolute one. Resolve once — `resolve` is a
  // no-op for absolute paths and anchors relative ones at the process cwd,
  // which is the project root wherever Astro runs.
  const contentRoot = options.contentRoot
    ? resolve(options.contentRoot)
    : undefined;

  const splice = async (
    node: MdastNode,
    statement: IncludeStatement,
    ctx: IncludeVisitorContext
  ): Promise<string> => {
    if (!statement.target) {
      const message = "<include> needs a file path as its text.";
      ctx.report({ message, node, severity: "warning" });
      return errorBlock(message);
    }
    if (!ctx.fileURL) {
      const message = `Include target ${statement.target} can't resolve: the compiler received no file URL.`;
      ctx.report({ message, node, severity: "warning" });
      return errorBlock(message);
    }
    const expanded = await expandIncludeTarget(statement, {
      contentRoot,
      sourcePath: fileURLToPath(ctx.fileURL),
    });
    if ("error" in expanded) {
      ctx.report({
        message: expanded.error.message,
        node,
        severity: "warning",
      });
      return errorBlock(expanded.error.message);
    }
    for (const nested of expanded.errors) {
      ctx.report({ message: nested.message, node, severity: "warning" });
    }
    return expanded.text;
  };

  /**
   * Splice every statement line in a text block; `null` when none matched.
   * Statement detection mirrors the string-level scanner's `.md` line rules
   * (`parseIncludeLine`, HTML comment tracking) so the rendered page and the
   * indexed/mirrored surfaces agree on which lines splice: a statement inside
   * `<!-- -->` or indented like code stays verbatim on both sides.
   */
  const spliceLines = async (
    node: MdastNode,
    text: string,
    ctx: IncludeVisitorContext
  ): Promise<string | null> => {
    let matched = false;
    let inComment = false;
    const lines = await Promise.all(
      text.split("\n").map((line) => {
        const wasInComment = inComment;
        inComment = advanceHtmlCommentState(line, inComment);
        const statement = wasInComment ? null : parseIncludeLine(line);
        if (!statement) {
          return line;
        }
        matched = true;
        return splice(node, statement, ctx);
      })
    );
    return matched ? lines.join("\n") : null;
  };

  return {
    async html(node: HtmlNode, ctx: IncludeVisitorContext) {
      if (!hasIncludeStatements(node.value)) {
        return;
      }
      // A statement adjacent to real block HTML gets swallowed into that
      // block's `html` node; splice each statement line, keep the rest.
      const replaced = await spliceLines(node, node.value, ctx);
      if (replaced !== null) {
        ctx.replaceNode(node, { raw: replaced });
      }
    },
    async mdxJsxFlowElement(node: JsxFlowNode, ctx: IncludeVisitorContext) {
      if (node.name !== "include") {
        return;
      }
      // The string-level scanner (search, mirrors, llms-full.txt, the HMR
      // graph) only recognizes single-line statements; a wrapped element
      // would render content those surfaces never see, so reject it loudly
      // instead of splicing it invisibly.
      const start = node.position?.start?.line;
      const end = node.position?.end?.line;
      if (start !== undefined && end !== undefined && start !== end) {
        const message =
          "<include> must be written on a single line: <include>./path.mdx</include>.";
        ctx.report({ message, node, severity: "warning" });
        ctx.replaceNode(node, { raw: errorBlock(message) });
        return;
      }
      ctx.replaceNode(node, {
        raw: await splice(node, statementFromJsx(node, ctx), ctx),
      });
    },
    name: "blume-include",
    // Positions are opt-in since satteri 0.10 (the parse skips the line index
    // when no plugin reads them); both the paragraph slice recovery and the
    // multi-line JSX rejection depend on them.
    options: { position: true },
    async paragraph(node: PositionedNode, ctx: IncludeVisitorContext) {
      // `<include>` isn't a known block-level HTML tag, so in plain `.md` a
      // statement line parses as a paragraph of inline `html` + text nodes.
      // Recover the raw text by position and splice the statement lines. The
      // slice is widened to whole source lines so container markers the
      // paragraph position excludes (a blockquote's `>`, a list item's `-`)
      // stay visible — a statement inside those containers is not on a line
      // of its own, and the string-level scanner never expands it, so
      // splicing here would render content search and the mirrors never see.
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start === undefined || end === undefined) {
        return;
      }
      const lineStart = ctx.source.lastIndexOf("\n", start - 1) + 1;
      const lineEndIndex = ctx.source.indexOf("\n", end);
      const lineEnd = lineEndIndex === -1 ? ctx.source.length : lineEndIndex;
      const text = ctx.source.slice(lineStart, lineEnd);
      if (!hasIncludeStatements(text)) {
        return;
      }
      const replaced = await spliceLines(node, text, ctx);
      if (replaced !== null) {
        ctx.replaceNode(node, { raw: replaced });
      }
    },
  };
};

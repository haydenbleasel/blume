import type { ApiOperationRef, ApiSpecData } from "./model.ts";

/**
 * Lower a parsed spec into MDX for the staged content source. Each operation and
 * the spec overview become a thin MDX page: the frontmatter carries the
 * searchable `title` (so operations flow into Blume's search, OG, and llms.txt),
 * the operation/overview **description is emitted as markdown in the body** so it
 * renders parsed (links, formatting) and is indexed, and the structured UI is
 * deferred to a Blume-owned component (`<Operation>` / `<ApiOverview>`). The
 * catch-all renders the frontmatter title as the page `<h1>`, so the components
 * omit their own top heading.
 */

// Neutralize the few characters MDX treats specially (`{` expressions, `<` JSX)
// so an arbitrary spec description can be embedded in the body verbatim without
// breaking compilation. They render as their literal selves.
const MDX_UNSAFE = /[<>{}]/gu;
const ENTITIES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "{": "&#123;",
  "}": "&#125;",
};
// MDX also parses lines starting with `import`/`export` as ESM ("import the
// SDK…" is common spec prose). Entity-escape the keyword's first letter so the
// construct can't match; it still renders as the literal word.
const MDX_ESM_KEYWORD = /^(?<keyword>import|export)\b/gmu;
const mdxSafe = (text: string): string =>
  text
    .replace(MDX_UNSAFE, (char) => ENTITIES[char] ?? char)
    .replace(
      MDX_ESM_KEYWORD,
      (keyword) => `&#${keyword.codePointAt(0)};${keyword.slice(1)}`
    );

/** Frontmatter + body for one operation or overview page. */
export interface RenderedPage {
  data: Record<string, unknown>;
  body: string;
}

/** Prepend a markdown description (if any) above a component invocation. */
const withDescription = (description: string, component: string): string =>
  description.trim()
    ? `${mdxSafe(description.trim())}\n\n${component}`
    : component;

export const operationMdx = (
  spec: ApiSpecData,
  operation: ApiOperationRef
): RenderedPage => {
  const method = operation.method.toUpperCase();
  const title = operation.summary || `${method} ${operation.path}`;
  // Skip the body description when it only repeats the summary (the `<h1>`) —
  // common in specs that set summary and description to the same string.
  const description =
    operation.description.trim() === operation.summary.trim()
      ? ""
      : operation.description;
  return {
    body: withDescription(
      description,
      `<Operation source="${spec.slug}" id="${operation.key}" />`
    ),
    data: {
      ...(operation.deprecated ? { deprecated: true } : {}),
      search: { tags: [operation.tag, method] },
      sidebar: { badge: method, label: operation.summary || operation.path },
      title,
      // Signals the two-column API layout (request panel instead of the TOC).
      type: "openapi-operation",
    },
  };
};

export const overviewMdx = (spec: ApiSpecData): RenderedPage => ({
  body: withDescription(
    spec.description,
    `<ApiOverview source="${spec.slug}" />`
  ),
  data: {
    sidebar: { label: "Overview" },
    title: spec.title || spec.label,
  },
});

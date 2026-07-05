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
// Backtick code — inline spans and fences alike — is already literal in MDX,
// and entities are NOT decoded inside it, so escaping there would render the
// entity text verbatim (`/pets/&#123;petId&#125;`). Matching any balanced
// backtick run covers `code`, ``code``, and ```fences``` in one shot.
const BACKTICK_CODE = /(?<bt>`+)[\s\S]*?\k<bt>/gu;

const escapeProse = (text: string): string =>
  text
    .replace(MDX_UNSAFE, (char) => ENTITIES[char] ?? char)
    .replace(
      MDX_ESM_KEYWORD,
      (keyword) => `&#${keyword.codePointAt(0)};${keyword.slice(1)}`
    );

/** Escape MDX-special syntax in prose while leaving backtick code verbatim. */
const mdxSafe = (text: string): string => {
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(BACKTICK_CODE)) {
    const start = match.index ?? 0;
    out += escapeProse(text.slice(cursor, start));
    out += match[0];
    cursor = start + match[0].length;
  }
  return out + escapeProse(text.slice(cursor));
};

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

export const overviewMdx = (spec: ApiSpecData): RenderedPage => {
  // Tag sections: declared tags in spec order, then any tag an operation
  // references that isn't declared under `tags`. The section headings are
  // emitted as real markdown `##` (not markup inside a component) so the
  // markdown pipeline gives them ids, permalink anchors, and table-of-contents
  // entries; only the operation-link list defers to a component.
  const operations = Object.values(spec.operations);
  // Dedupe by slug: two declared tags that slugify identically (`Store` and
  // `store`) must render one section, not the same operation list twice.
  const sections: typeof spec.tags = [];
  const known = new Set<string>();
  for (const tag of spec.tags) {
    if (!known.has(tag.slug)) {
      known.add(tag.slug);
      sections.push(tag);
    }
  }
  for (const operation of operations) {
    if (!known.has(operation.tagSlug)) {
      known.add(operation.tagSlug);
      sections.push({
        description: "",
        name: operation.tag,
        slug: operation.tagSlug,
      });
    }
  }
  const tagSections = sections
    .filter((tag) =>
      operations.some((operation) => operation.tagSlug === tag.slug)
    )
    .map((tag) =>
      [
        `## ${mdxSafe(tag.name)}`,
        ...(tag.description.trim() ? [mdxSafe(tag.description.trim())] : []),
        `<ApiTagOperations source="${spec.slug}" tag="${tag.slug}" />`,
      ].join("\n\n")
    );
  return {
    body: [
      withDescription(
        spec.description,
        `<ApiOverview source="${spec.slug}" />`
      ),
      ...tagSections,
    ].join("\n\n"),
    data: {
      sidebar: { label: "Overview" },
      title: spec.title || spec.label,
    },
  };
};

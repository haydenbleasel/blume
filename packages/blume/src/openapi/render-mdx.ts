import type { ApiOperationRef, ApiSpecData } from "./model.ts";
import type { ReferenceSource } from "./references.ts";

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

// Neutralize the few characters MDX treats specially (`{` expressions, `<`
// JSX) so an arbitrary spec description can be embedded in the body verbatim
// without breaking compilation. They render as their literal selves. `>` is
// deliberately not escaped: it isn't MDX-special on its own, and escaping it
// turns a `> Note:` blockquote into literal "&gt; Note:" text.
const MDX_UNSAFE = /[<{}]/gu;
const ENTITIES: Record<string, string> = {
  "<": "&lt;",
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
// backtick run covers `code`, ``code``, and ```fences``` in one shot. Both
// runs are pinned by the backtick lookarounds: CommonMark pairs a span only
// with an *equal-length* run, so without them a lone backtick would "close" on
// the first backtick of a longer fence run — leaving `{` in the real prose
// unescaped (a compile error) and escaping entities into the fence body.
const BACKTICK_CODE = /(?<!`)(?<bt>`+)(?!`)[\s\S]*?(?<!`)\k<bt>(?!`)/gu;

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

// Meta descriptions. A page that sets none falls back to the site-wide default,
// so a spec's pages would otherwise all ship one identical description — what
// search engines treat as duplicate content. These go in `seo.description`, not
// `description`: the prose already renders in the body, and a `description`
// frontmatter field would print it a second time as the page subtitle.
const META_DESCRIPTION_MAX = 160;
const PARAGRAPH_BREAK = /\n\s*\n/u;
const MARKDOWN_LINK = /\[(?<text>[^\]]*)\]\([^)]*\)/gu;
const MARKDOWN_MARKS = /[*_`#>]/gu;
const WHITESPACE = /\s+/gu;
const TRAILING_WORD = /\s+\S*$/u;

/** Flatten markdown prose to its first paragraph as single-line plain text. */
const plainProse = (markdown: string): string =>
  (markdown.trim().split(PARAGRAPH_BREAK).at(0) ?? "")
    .replace(MARKDOWN_LINK, "$<text>")
    .replace(MARKDOWN_MARKS, "")
    .replace(WHITESPACE, " ")
    .trim();

/** Cap `text` at `max` characters, cutting on a word boundary. */
const clip = (text: string, max: number): string => {
  if (max <= 0) {
    return "";
  }
  if (text.length <= max) {
    return text;
  }
  const head = text.slice(0, max - 1);
  const onWordBoundary = head.replace(TRAILING_WORD, "");
  // One very long token — an endpoint path has no spaces — would be dropped
  // whole, leaving a stub. Hard-cut it instead of losing it.
  return `${onWordBoundary.length >= max / 2 ? onWordBoundary : head}…`;
};

const apiName = (spec: ApiSpecData): string => spec.title || spec.label;

/**
 * The spec's own prose for the operation, followed by the endpoint it documents
 * — so every operation page carries a distinct, self-describing meta
 * description even when the spec's summaries are terse.
 */
const operationDescription = (
  spec: ApiSpecData,
  operation: ApiOperationRef
): string => {
  const endpoint = `${operation.method.toUpperCase()} ${operation.path}`;
  const suffix = `Reference for the ${endpoint} endpoint in the ${apiName(spec)} API.`;
  const prose = clip(
    plainProse(operation.description || operation.summary),
    META_DESCRIPTION_MAX - suffix.length - 1
  );
  return clip([prose, suffix].filter(Boolean).join(" "), META_DESCRIPTION_MAX);
};

/** Prepend a markdown description (if any) above a component invocation. */
const withDescription = (description: string, component: string): string =>
  description.trim()
    ? `${mdxSafe(description.trim())}\n\n${component}`
    : component;

export const operationMdx = (
  spec: ApiSpecData,
  operation: ApiOperationRef,
  reference?: Pick<
    ReferenceSource,
    "includeInLlms" | "includeInSearch" | "noindex"
  >
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
      ...(reference?.includeInLlms === false ? { ai: { exclude: true } } : {}),
      ...(operation.deprecated ? { deprecated: true } : {}),
      search: {
        ...(reference?.includeInSearch === false ? { exclude: true } : {}),
        tags: [operation.tag, method],
      },
      seo: {
        description: operationDescription(spec, operation),
        ...(reference?.noindex ? { noindex: true } : {}),
      },
      sidebar: { badge: method, label: operation.summary || operation.path },
      title,
      // Signals the two-column API layout (request panel instead of the TOC).
      type: "openapi-operation",
    },
  };
};

export const overviewMdx = (
  spec: ApiSpecData,
  reference?: Pick<
    ReferenceSource,
    "includeInLlms" | "includeInSearch" | "noindex"
  >
): RenderedPage => {
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
  const tagSections: string[] = [];
  for (const tag of sections) {
    if (!operations.some((operation) => operation.tagSlug === tag.slug)) {
      continue;
    }
    const description = tag.description.trim()
      ? [mdxSafe(tag.description.trim())]
      : [];
    tagSections.push(
      [
        `## ${mdxSafe(tag.name)}`,
        ...description,
        `<ApiTagOperations source="${spec.slug}" tag="${tag.slug}" />`,
      ].join("\n\n")
    );
  }
  return {
    body: [
      withDescription(
        spec.description,
        `<ApiOverview source="${spec.slug}" />`
      ),
      ...tagSections,
    ].join("\n\n"),
    data: {
      ...(reference?.includeInLlms === false ? { ai: { exclude: true } } : {}),
      ...(reference?.includeInSearch === false
        ? { search: { exclude: true } }
        : {}),
      seo: {
        description:
          clip(plainProse(spec.description), META_DESCRIPTION_MAX) ||
          `${apiName(spec)} API reference.`,
        ...(reference?.noindex ? { noindex: true } : {}),
      },
      sidebar: { label: "Overview" },
      title: apiName(spec),
    },
  };
};

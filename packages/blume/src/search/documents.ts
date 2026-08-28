import type { Nodes } from "mdast";
import { markdownToMdast, mdxToMdast } from "satteri";
import type { MdxJsxAttributeUnion } from "satteri";

import {
  downlevelComponents,
  exampleComponentSerializers,
} from "../ai/component-markdown.ts";
import type { ComponentMarkdown } from "../ai/component-markdown.ts";
import { applyAudienceVisibility } from "../ai/visibility.ts";
import type { VisibilityAudience } from "../ai/visibility.ts";
import matter from "../core/frontmatter.ts";
import { parseHeadingMarkers } from "../core/heading-markers.ts";
import { contentIndexable } from "../core/manifest.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { readExpandedEntryText } from "../core/sources/read.ts";
import type { NavNode, PageRecord } from "../core/types.ts";
import { parseCodeTitle } from "../markdown/code-title.ts";
import { MARKDOWN_FEATURES, MDX_FEATURES } from "../markdown/features.ts";
import { pageFacets } from "./facets.ts";

/** A document indexed by the client-side search providers (Orama, FlexSearch). */
export interface SearchDocument {
  route: string;
  title: string;
  description: string;
  content: string;
  /** Ancestor section labels for the result breadcrumb, e.g. `["Guides"]`. */
  breadcrumb: string[];
  /** Top-level section label, used by the search filter pills. */
  section: string;
  /** Locale code, so the dialog can filter results to the active language. */
  locale: string;
  /** Resolved page `type` (`doc`, `blog`, a custom `rfc`…), for type filters. */
  contentType: string;
  /** Docs version (`""` for the current docs), so results scope to the viewed version. */
  version: string;
  /** Frontmatter `search.tags`, surfaced for hosted-provider faceting. */
  tags?: string[];
  /**
   * Declared facet values (`content.types.<type>.facets`), key → value.
   * Filterable through the MCP tools' `filters` input.
   */
  facets?: Record<string, string>;
}

/**
 * A record uploaded to a hosted search backend (Algolia, Orama Cloud,
 * Typesense, Mixedbread). `_id` is the stable per-page key; each sync adapts it
 * to the backend's own id field (`objectID`, `id`, …).
 */
export interface SearchRecord {
  _id: string;
  url: string;
  title: string;
  description: string;
  content: string;
  /** Locale code, carried as a facet for per-language filtering. */
  locale: string;
  /**
   * Docs version, carried as a facet for per-version filtering. The current
   * docs upload as `"current"` — hosted backends treat an empty facet value
   * unreliably, so the sentinel stands in for the empty version id.
   */
  version: string;
  /** Single faceting tag (the first frontmatter tag, when present). */
  tag?: string;
}

// Tag-shaped only: a name (or closing slash/fragment) right after `<`, and no
// newline inside. Applied *within* html/JSX nodes so their inner prose is
// kept; the surrounding Markdown is walked as a tree, so a bare `<` in prose
// ("costs < 5 credits") is ordinary text and never at risk.
const HTML_OR_JSX = /<\/?[a-zA-Z][^\n<>]*>|<\/?>/gu;
const WHITESPACE = /\s+/gu;

// Parents whose children are inline: no separator is inserted after them, or
// `re*ally*` would index as `re ally`. Every other parent is block-shaped and
// ends with a space so adjacent paragraphs/headings/cells don't fuse.
const INLINE_PARENTS = new Set([
  "delete",
  "emphasis",
  "footnoteReference",
  "link",
  "linkReference",
  "mdxJsxTextElement",
  "strong",
  "subscript",
  "superscript",
]);

// Nodes that never render as prose: image alt text was never indexed, MDX
// expressions (`{props.x}`) and ESM (`export const meta`) are code, and math
// is LaTeX source rendered by KaTeX, not searchable words.
const NON_PROSE = new Set<Nodes["type"]>([
  "image",
  "imageReference",
  "inlineMath",
  "math",
  "mdxFlowExpression",
  "mdxTextExpression",
  "mdxjsEsm",
]);

interface PlainTextOptions {
  includeCodeBlocks: boolean;
}

type PageFormat = PageRecord["format"];

// Front matter is already off (core/frontmatter.ts) by the time a body gets
// here, so a body that opens with a `---` divider must read as a thematic
// break rather than a second front matter block.
const MD_PARSE = { features: { ...MARKDOWN_FEATURES, frontmatter: false } };
const MDX_PARSE = { features: { ...MDX_FEATURES, frontmatter: false } };

const parseMdx = (markdown: string): Nodes | undefined => {
  try {
    return mdxToMdast(markdown, MDX_PARSE);
  } catch {
    return undefined;
  }
};

/**
 * Parse a page body the way the renderer reads it. `.mdx` pages go through
 * the MDX grammar with the renderer's feature set, so components become
 * `mdxJsx*` nodes whose children — prose and fences, however they're indented
 * — walk like top-level content, and `:::` directives and `$$` math parse as
 * such; Markdown would instead fold a tight component into one html node and
 * read its indented children as an indented code block. A page the MDX
 * grammar rejects (an HTML comment, an unclosed tag) fails to render too, so
 * rather than fail the whole index for one broken page it is read as Markdown
 * — a rough but searchable reduction until the author fixes the page.
 */
const parseMarkdown = (markdown: string, format: PageFormat): Nodes =>
  (format === "mdx" ? parseMdx(markdown) : undefined) ??
  markdownToMdast(markdown, MD_PARSE);

// Fenced code is excluded from the plain index by default (ranking noise) —
// the "markdown" extraction keeps it for Ask AI grounding. Code-heavy docs opt
// in via `search.indexing.includeCodeBlocks`, which indexes the fence body and
// its rendered title (```ts blume.config.ts) but never the fence markers,
// language, or other meta keywords.
const collectCode = (
  node: Extract<Nodes, { type: "code" }>,
  out: string[],
  options: PlainTextOptions
): void => {
  if (!options.includeCodeBlocks) {
    return;
  }
  const title = parseCodeTitle(node.meta ?? undefined);
  if (title) {
    out.push(title, " ");
  }
  out.push(node.value, " ");
};

// A component's string props are its visible text — a Card's `title` and
// `description`, a Tab's `title` — so they index like prose; expression props
// (`type={{ … }}`) are code and stay out.
const collectJsxAttributes = (
  attributes: MdxJsxAttributeUnion[],
  out: string[]
): void => {
  for (const attribute of attributes) {
    if (
      attribute.type === "mdxJsxAttribute" &&
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the value is satteri's `string | ValueExpression` union; the string literal is the domain value
      typeof attribute.value === "string"
    ) {
      out.push(attribute.value, " ");
    }
  }
};

// Block boundaries separate words; so does an empty inline element (`<br />`,
// a self-closing icon), which otherwise fuses its neighbors.
const separatesWords = (node: Extract<Nodes, { children: unknown }>): boolean =>
  !INLINE_PARENTS.has(node.type) || node.children.length === 0;

/** Fold one mdast node into the plain-text accumulator. */
const collectText = (
  node: Nodes,
  out: string[],
  options: PlainTextOptions
): void => {
  if (NON_PROSE.has(node.type)) {
    return;
  }
  switch (node.type) {
    case "code": {
      collectCode(node, out, options);
      return;
    }
    // Inline code is kept verbatim — `Array<T>` is a type parameter, not a
    // tag, and its tokens must stay searchable.
    case "inlineCode": {
      out.push(node.value);
      return;
    }
    // A raw-HTML run. In a `.md` page (or an `.mdx` page MDX couldn't parse)
    // CommonMark folds a block-level `<Callout>` with no blank lines into ONE
    // html node holding all its inner prose, so the node can't just be
    // dropped — strip the tag-shaped runs and keep the text.
    case "html": {
      out.push(node.value.replaceAll(HTML_OR_JSX, " "));
      return;
    }
    case "break": {
      out.push(" ");
      return;
    }
    // Trailing heading markers (`[#custom-id]`, `{#custom-id}`, `[!toc]`,
    // `[toc]`) are anchor

    // metadata, not prose — strip them so they never pollute the index. Only
    // a marker that ends the heading's final plain-text child counts,
    // mirroring the renderer: a heading ending in inline code or an image
    // keeps its bracketed text on the page (so it stays searchable), and a
    // heading that is nothing but markers renders them literally.
    case "heading": {
      const last = node.children.at(-1);
      const trailing = last?.type === "text" ? last : undefined;
      const inner: string[] = [];
      const kept = trailing ? node.children.slice(0, -1) : node.children;
      for (const child of kept) {
        collectText(child, inner, options);
      }
      if (trailing) {
        const stripped = parseHeadingMarkers(trailing.value).text;
        const literal = stripped === "" && node.children.length === 1;
        inner.push(literal ? trailing.value : stripped);
      }
      out.push(inner.join("").trimEnd(), " ");
      return;
    }
    default: {
      break;
    }
  }
  if ("value" in node) {
    out.push(node.value);
    return;
  }
  if ("attributes" in node && Array.isArray(node.attributes)) {
    collectJsxAttributes(node.attributes, out);
  }
  if ("children" in node) {
    for (const child of node.children) {
      collectText(child, out, options);
    }
    if (separatesWords(node)) {
      out.push(" ");
    }
  }
};

/**
 * Reduce Markdown/MDX to plain, searchable text: parse (GFM included) and walk
 * the tree instead of regex-stripping the source, so reference-style links,
 * autolinks, setext headings, tables, and literal `*`/`~`/`>` in prose all
 * reduce correctly. This feeds the client index *and* every hosted-provider
 * record, so anything lost here is a permanent search-quality loss.
 */
const toPlainText = (
  markdown: string,
  format: PageFormat,
  options: PlainTextOptions
): string => {
  const out: string[] = [];
  collectText(parseMarkdown(markdown, format), out, options);
  return out.join("").replaceAll(WHITESPACE, " ").trim();
};

interface Crumbs {
  breadcrumb: string[];
  section: string;
}

/**
 * Map each page route to its ancestor section labels by walking the nav sidebar
 * once. The nearest ancestor group — the sidebar section a page appears under —
 * becomes its `section`, the dimension the search filter pills group by, so the
 * pills mirror the visible sidebar (and honor folder-meta renames).
 */
const buildCrumbIndex = (sidebar: NavNode[]): Map<string, Crumbs> => {
  const index = new Map<string, Crumbs>();
  // A config-sidebar section's landing page (the group's `root`) lives on the
  // *group* node, not on any page leaf — record it under the group's own label
  // so the section's landing page carries the same facet as its children. A
  // real page leaf for the route (filesystem sidebars emit index pages as
  // leaves) wins, so group routes are merged in only where no leaf claimed one.
  const groupRoutes = new Map<string, Crumbs>();
  const walk = (nodes: NavNode[], trail: string[]): void => {
    for (const node of nodes) {
      if (node.kind === "group") {
        if (node.route && !groupRoutes.has(node.route)) {
          groupRoutes.set(node.route, {
            breadcrumb: [...trail, node.label],
            section: node.label,
          });
        }
        walk(node.children, [...trail, node.label]);
      } else if (node.route) {
        index.set(node.route, {
          breadcrumb: trail,
          section: trail.at(-1) ?? "",
        });
      }
    }
  };
  walk(sidebar, []);
  for (const [route, crumbs] of groupRoutes) {
    if (!index.has(route)) {
      index.set(route, crumbs);
    }
  }
  return index;
};

interface BuildOptions {
  includeWhenDisabled?: boolean;
  content?: "markdown" | "plain";
  audience?: VisibilityAudience;
}

/**
 * Read a page's body and reduce it per the extraction options: the
 * `"markdown"` body is agent-facing, so its components are downleveled (with
 * the page's front matter in scope for prop expressions); the plain body is
 * parsed and walked to searchable text.
 */
const pageBody = async (
  project: BlumeProject,
  page: PageRecord | undefined,
  options: Pick<BuildOptions, "audience" | "content"> | undefined,
  components: Record<string, ComponentMarkdown> | undefined,
  plain: PlainTextOptions
): Promise<string> => {
  if (!page) {
    return "";
  }
  const parsed = matter(await readExpandedEntryText(project, page));
  const visible = applyAudienceVisibility(
    parsed.content,
    options?.audience ?? "web"
  );
  return options?.content === "markdown"
    ? downlevelComponents(visible.trim(), components, parsed.data)
    : toPlainText(visible, page.format, plain);
};

/**
 * Build search documents from the content graph. Only indexable pages are
 * included (per the route manifest), and content comes from the source files,
 * so the index is identical in dev and build.
 *
 * Pass `includeWhenDisabled` to index pages on their content merits even when
 * the search provider is `none` — used by the MCP server, which is a separate
 * feature from on-page search.
 *
 * `content` selects the extraction: `"plain"` (default) strips Markdown to bare
 * searchable text; `"markdown"` keeps the body's Markdown — code blocks, lists,
 * headings — for Ask AI grounding, where fenced examples are often the answer
 * and stripping them makes the model unable to cite content the docs do contain.
 * The `"markdown"` body is agent-facing, so components are downleveled with the
 * same serializers the `.md` mirror, llms-full.txt and MCP `get_page` use: a
 * page whose body is a `<CardGroup>` of `<Card>`s is prose to a reader and bare
 * JSX to anything reading the source, and section landing pages are exactly
 * that shape.
 *
 * `audience` resolves `<Visibility>` blocks before extraction: `"web"`
 * (default) keeps web-only content and drops agents-only blocks — the site
 * search and hosted syncs must not surface content the page hides — while
 * `"agents"` mirrors llms-full.txt/MCP `get_page` (web removed, agents kept).
 *
 * Whether fenced code joins the plain extraction is site-wide policy, read
 * from `search.indexing.includeCodeBlocks` here rather than threaded by each
 * caller, so the client index, hosted syncs, eject, and the MCP `search_docs`
 * index can't drift apart.
 */
export const buildSearchDocuments = async (
  project: BlumeProject,
  options?: BuildOptions
): Promise<SearchDocument[]> => {
  const pageById = new Map(project.graph.pages.map((page) => [page.id, page]));
  const plain: PlainTextOptions = {
    includeCodeBlocks: project.config.search.indexing.includeCodeBlocks,
  };

  // Build the crumb index from every locale's sidebar (their nodes carry
  // locale-prefixed routes), so localized pages get the right section/breadcrumb.
  // Falls back to the single default-locale nav when i18n is off.
  const byLocale = Object.values(project.graph.navigationByLocale ?? {});
  // Archived versions' trees contribute too, so snapshot pages get their own
  // section/breadcrumb instead of falling through to the "Docs" default.
  const byVersion = Object.values(project.graph.navigationByVersion ?? {})
    .flatMap((locales) => Object.values(locales))
    .map((nav) => nav.sidebar);
  const sidebars = [
    ...(byLocale.length > 0
      ? byLocale.map((nav) => nav.sidebar)
      : [project.graph.navigation?.sidebar ?? []]),
    ...byVersion,
  ];
  const crumbs = new Map<string, Crumbs>();
  for (const sidebar of sidebars) {
    for (const [route, crumb] of buildCrumbIndex(sidebar)) {
      crumbs.set(route, crumb);
    }
  }

  const indexable = project.manifest.routes.filter((route) => {
    if (!options?.includeWhenDisabled) {
      return route.indexable;
    }
    const page = pageById.get(route.id);
    return page ? contentIndexable(page, project.config) : false;
  });

  // Serializers for the "markdown" extraction, layered the way
  // `buildRawMarkdown` layers them: examples first, so a user
  // `markdownComponents` entry of the same name still wins. Built once —
  // `downlevelComponents` rebuilds its registry per call otherwise.
  const components =
    options?.content === "markdown"
      ? {
          ...exampleComponentSerializers(project.examples ?? {}),
          ...project.config.ai.markdownComponents,
        }
      : undefined;

  return await Promise.all(
    indexable.map(async (route) => {
      const page = pageById.get(route.id);
      const body = await pageBody(project, page, options, components, plain);
      const tags = page?.meta?.search?.tags;
      const crumb = crumbs.get(route.path);
      const facets = page ? pageFacets(page, project.config) : undefined;
      const document: SearchDocument = {
        breadcrumb: crumb?.breadcrumb ?? [],
        content: body,
        contentType: route.contentType,
        description: page?.description ?? "",
        locale: route.locale,
        route: route.path,
        section: crumb?.section || "Docs",
        tags: tags && tags.length > 0 ? tags : undefined,
        title: route.title,
        version: route.version,
      };
      if (facets) {
        document.facets = facets;
      }
      return document;
    })
  );
};

/**
 * Map per-page search documents to the flat record shape hosted backends
 * ingest. One record per page, keyed by route; the first tag becomes the
 * faceting `tag`.
 */
export const toSearchRecords = (documents: SearchDocument[]): SearchRecord[] =>
  documents.map((doc) => ({
    _id: doc.route,
    content: doc.content,
    description: doc.description,
    locale: doc.locale,
    tag: doc.tags?.[0],
    title: doc.title,
    url: doc.route,
    version: doc.version || "current",
  }));

import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import { applyAudienceVisibility } from "../ai/visibility.ts";
import type { VisibilityAudience } from "../ai/visibility.ts";
import matter from "../core/frontmatter.ts";
import { contentIndexable } from "../core/manifest.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { readEntryText } from "../core/sources/read.ts";
import type { NavNode } from "../core/types.ts";
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
  "strong",
]);

interface PlainTextOptions {
  includeFencedCodeBlocks?: boolean;
}

/** Fold one mdast node into the plain-text accumulator. */
const collectText = (
  node: Nodes,
  out: string[],
  options: PlainTextOptions
): void => {
  switch (node.type) {
    // Fenced code is excluded from the plain index by default (ranking noise),
    // but code-heavy docs can opt in without indexing Markdown markup too.
    case "code": {
      if (options.includeFencedCodeBlocks) {
        out.push(node.value, " ");
      }
      return;
    }
    // Image alt text was never indexed.
    case "image":
    case "imageReference": {
      return;
    }
    // Inline code is kept verbatim — `Array<T>` is a type parameter, not a
    // tag, and its tokens must stay searchable.
    case "inlineCode": {
      out.push(node.value);
      return;
    }
    // A raw-HTML/JSX run. CommonMark parses a block-level `<Callout>` with no
    // blank lines as ONE html node holding all its inner prose, so the node
    // can't just be dropped — strip the tag-shaped runs and keep the text.
    case "html": {
      out.push(node.value.replaceAll(HTML_OR_JSX, " "));
      return;
    }
    case "break": {
      out.push(" ");
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
  if ("children" in node) {
    for (const child of node.children) {
      collectText(child, out, options);
    }
    if (!INLINE_PARENTS.has(node.type)) {
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
  options: PlainTextOptions = {}
): string => {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const out: string[] = [];
  collectText(tree, out, options);
  return out.join("").replaceAll(WHITESPACE, " ").trim();
};

type SearchContentMode = "markdown" | "plain";

const extractSearchContent = (
  markdown: string,
  options?: {
    content?: SearchContentMode;
    includeFencedCodeBlocks?: boolean;
  }
): string =>
  options?.content === "markdown"
    ? markdown.trim()
    : toPlainText(markdown, {
        includeFencedCodeBlocks: options?.includeFencedCodeBlocks ?? false,
      });

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
 *
 * `audience` resolves `<Visibility>` blocks before extraction: `"web"`
 * (default) keeps web-only content and drops agents-only blocks — the site
 * search and hosted syncs must not surface content the page hides — while
 * `"agents"` mirrors llms-full.txt/MCP `get_page` (web removed, agents kept).
 */
export const buildSearchDocuments = async (
  project: BlumeProject,
  options?: {
    includeWhenDisabled?: boolean;
    content?: SearchContentMode;
    includeFencedCodeBlocks?: boolean;
    audience?: VisibilityAudience;
  }
): Promise<SearchDocument[]> => {
  const pageById = new Map(project.graph.pages.map((page) => [page.id, page]));

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

  return await Promise.all(
    indexable.map(async (route) => {
      const page = pageById.get(route.id);
      const raw = page ? await readEntryText(project, page) : "";
      const source = raw ? matter(raw).content : "";
      const visible = applyAudienceVisibility(
        source,
        options?.audience ?? "web"
      );
      const body = extractSearchContent(visible, options);
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

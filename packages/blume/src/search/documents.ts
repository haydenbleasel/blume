import matter from "gray-matter";

import { contentIndexable } from "../core/manifest.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { readEntryText } from "../core/sources/read.ts";
import type { NavNode } from "../core/types.ts";

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
  /** Frontmatter `search.tags`, surfaced for hosted-provider faceting. */
  tags?: string[];
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
  /** Single faceting tag (the first frontmatter tag, when present). */
  tag?: string;
}

const CODE_FENCE = /```[\s\S]*?```/gu;
const INLINE_CODE = /`(?<code>[^`]+)`/gu;
const HTML_OR_JSX = /<[^>]+>/gu;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/gu;
const LINK = /\[(?<text>[^\]]*)\]\([^)]*\)/gu;
const HEADING_MARK = /^#{1,6}\s+/gmu;
const MARKDOWN_PUNCT = /[*_~>]+/gu;
const WHITESPACE = /\s+/gu;

/** Reduce Markdown/MDX to plain, searchable text. */
const toPlainText = (markdown: string): string =>
  markdown
    .replaceAll(CODE_FENCE, " ")
    .replaceAll(IMAGE, " ")
    .replaceAll(LINK, "$<text>")
    .replaceAll(HTML_OR_JSX, " ")
    .replaceAll(INLINE_CODE, "$<code>")
    .replaceAll(HEADING_MARK, "")
    .replaceAll(MARKDOWN_PUNCT, " ")
    .replaceAll(WHITESPACE, " ")
    .trim();

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
  const walk = (nodes: NavNode[], trail: string[]): void => {
    for (const node of nodes) {
      if (node.kind === "group") {
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
 */
export const buildSearchDocuments = async (
  project: BlumeProject,
  options?: { includeWhenDisabled?: boolean }
): Promise<SearchDocument[]> => {
  const pageById = new Map(project.graph.pages.map((page) => [page.id, page]));

  // Build the crumb index from every locale's sidebar (their nodes carry
  // locale-prefixed routes), so localized pages get the right section/breadcrumb.
  // Falls back to the single default-locale nav when i18n is off.
  const byLocale = Object.values(project.graph.navigationByLocale ?? {});
  const sidebars =
    byLocale.length > 0
      ? byLocale.map((nav) => nav.sidebar)
      : [project.graph.navigation?.sidebar ?? []];
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
      const body = raw ? toPlainText(matter(raw).content) : "";
      const tags = page?.meta?.search?.tags;
      const crumb = crumbs.get(route.path);
      return {
        breadcrumb: crumb?.breadcrumb ?? [],
        content: body,
        description: page?.description ?? "",
        locale: route.locale,
        route: route.path,
        section: crumb?.section || "Docs",
        tags: tags && tags.length > 0 ? tags : undefined,
        title: route.title,
      };
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
  }));

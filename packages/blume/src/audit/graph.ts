import type { LinkGraph, PageSnapshot } from "./types.ts";
import { resolveHref } from "./url.ts";

const add = (
  map: Map<string, Set<string>>,
  key: string,
  value: string
): void => {
  const existing = map.get(key);
  if (existing) {
    existing.add(value);
  } else {
    map.set(key, new Set([value]));
  }
};

/**
 * Build the internal link graph, keeping prose links and chrome links apart.
 *
 * The split is the whole point. Blume's sidebar links every navigable page from
 * every page, so a graph that lumps the two together concludes that every page
 * has hundreds of inbound links — which makes "orphan page" unfireable and makes
 * a single broken sidebar link look like N broken links, one per page.
 */
export const buildGraph = (
  pages: PageSnapshot[],
  origin: string | null
): LinkGraph => {
  const graph: LinkGraph = {
    chromeIn: new Map(),
    chromeOut: new Map(),
    contentIn: new Map(),
    contentOut: new Map(),
  };

  for (const page of pages) {
    for (const link of page.links) {
      const resolved = resolveHref(page.url, link.href, origin);
      if (resolved.kind !== "internal" && resolved.kind !== "self-origin") {
        continue;
      }
      const out = link.content ? graph.contentOut : graph.chromeOut;
      const incoming = link.content ? graph.contentIn : graph.chromeIn;
      add(out, page.url, resolved.path);
      add(incoming, resolved.path, page.url);
    }
  }

  return graph;
};

/**
 * Pages nothing links to from prose — reachable only through the sidebar.
 *
 * This is what an SEO means by "orphan": the page ships, but no other page's
 * body ever points a reader (or a crawler following editorial links) at it.
 * Non-indexable pages are excluded — a `noindex` page is *meant* to be
 * unreachable — as is the home page, which is nobody's job to link to.
 */
export const orphanPages = (
  pages: PageSnapshot[],
  graph: LinkGraph
): PageSnapshot[] =>
  pages.filter(
    (page) =>
      page.indexable &&
      page.url !== "/" &&
      (graph.contentIn.get(page.url)?.size ?? 0) === 0
  );

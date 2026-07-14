import type { NavNode, NavTab } from "../../core/types.ts";

/** A flat, ordered page reference used for previous/next pagination. */
export interface FlatPage {
  route: string;
  label: string;
  deprecated?: boolean;
}

/** A breadcrumb segment; `route` is absent for non-clickable group ancestors. */
export interface Crumb {
  label: string;
  route?: string;
}

/** Flatten the sidebar tree into ordered internal page links. */
export const flattenPages = (nodes: NavNode[]): FlatPage[] => {
  const out: FlatPage[] = [];
  const seen = new Set<string>();
  const add = (page: FlatPage): void => {
    if (seen.has(page.route)) {
      return;
    }
    seen.add(page.route);
    out.push(page);
  };
  const walk = (items: NavNode[]): void => {
    for (const item of items) {
      if (item.kind === "group") {
        if (item.route) {
          add({ label: item.label, route: item.route });
        }
        walk(item.children);
      } else if (item.pageId) {
        // Skip external links (no backing page).
        add(
          item.deprecated
            ? { deprecated: true, label: item.label, route: item.route }
            : { label: item.label, route: item.route }
        );
      }
    }
  };
  walk(nodes);
  return out;
};

/** Find the breadcrumb trail (group ancestors + page) for a route. */
export const findBreadcrumbs = (nodes: NavNode[], route: string): Crumb[] => {
  const search = (items: NavNode[], trail: Crumb[]): Crumb[] | null => {
    for (const item of items) {
      if (item.kind === "page") {
        if (item.route === route) {
          return [...trail, { label: item.label, route: item.route }];
        }
      } else {
        const crumb: Crumb = item.route
          ? { label: item.label, route: item.route }
          : { label: item.label };
        if (item.route === route) {
          return [...trail, crumb];
        }
        const found = search(item.children, [...trail, crumb]);
        if (found) {
          return found;
        }
      }
    }
    return null;
  };
  return search(nodes, []) ?? [];
};

/**
 * Whether `route` is the section root `base` or nested beneath it. Requires a
 * path boundary, so `/api-reference` is not under `/api`. The root `/` spans
 * every route.
 */
export const isUnderPath = (route: string, base: string): boolean =>
  base === "/" || route === base || route.startsWith(`${base}/`);

/**
 * The tab whose `path` is the longest prefix of `route`. The root tab (`/`)
 * acts as the fallback when no more specific tab matches.
 */
export const activeTabForRoute = (
  tabs: NavTab[],
  route: string
): NavTab | null => {
  let match: NavTab | null = null;
  for (const tab of tabs) {
    if (!isUnderPath(route, tab.path)) {
      continue;
    }
    if (!match || tab.path.length > match.path.length) {
      match = tab;
    }
  }
  return match;
};

/**
 * The children of the group whose path is `base`, searched at any depth — so a
 * content tree wrapped in a top-level container group still resolves to the
 * right section. Returns null when no group sits exactly at `base`.
 */
const sectionChildren = (nodes: NavNode[], base: string): NavNode[] | null => {
  for (const node of nodes) {
    if (node.kind !== "group") {
      continue;
    }
    if (node.path === base || node.route === base) {
      return node.children;
    }
    const deeper = sectionChildren(node.children, base);
    if (deeper) {
      return deeper;
    }
  }
  return null;
};

/** Whether a group maps to a header tab (matched on its path or link route). */
const isTabSection = (node: NavNode, tabPaths: Set<string>): boolean => {
  if (node.kind !== "group") {
    return false;
  }
  const byPath = node.path !== undefined && tabPaths.has(node.path);
  const byRoute = node.route !== undefined && tabPaths.has(node.route);
  return byPath || byRoute;
};

/**
 * Drop the groups that already own a header tab from the tree, at any depth —
 * so a root/un-tabbed route lists only the pages outside every tab's section
 * instead of duplicating each tab as a sidebar group. A container left empty by
 * this pruning is dropped too, so no bare heading is stranded. The root tab
 * (`/`) spans everything, so it never removes anything.
 */
const withoutTabSections = (nodes: NavNode[], tabs: NavTab[]): NavNode[] => {
  const tabPaths = new Set<string>();
  for (const tab of tabs) {
    if (tab.path !== "/") {
      tabPaths.add(tab.path);
    }
  }
  if (tabPaths.size === 0) {
    return nodes;
  }
  const prune = (items: NavNode[]): NavNode[] => {
    const kept: NavNode[] = [];
    for (const item of items) {
      if (isTabSection(item, tabPaths)) {
        continue;
      }
      if (item.kind === "group") {
        // A container left empty by pruning is dropped, so no bare heading is
        // stranded.
        const children = prune(item.children);
        if (children.length > 0) {
          kept.push({ ...item, children });
        }
      } else {
        kept.push(item);
      }
    }
    return kept;
  };
  return prune(nodes);
};

/**
 * Scope the sidebar to the active tab's section. With tabs configured, a route
 * under one tab shows only that tab's group — so a multi-section site (e.g.
 * Adapters / API / AI tabs) drills each tab into its own pages instead of one
 * global tree, the way Fumadocs' root folders do. On a route under no tab (or
 * the root `/` tab), the tab-owned groups are hidden so the root sidebar shows
 * only pages that don't belong to a tab.
 *
 * When a matched tab owns no sidebar group — a standalone page like the
 * generated changelog timeline (`/changelog`), or a tab whose source produced
 * no pages — the sidebar is empty. It must not fall back to the full tree: that
 * would leak every *other* tab's section (e.g. the OpenAPI operations) onto the
 * page. On a route under no tab, hiding the tab sections falls back to the full
 * sidebar only when it would otherwise blank, so an un-tabbed route stays full.
 */
export const sidebarForRoute = (
  sidebar: NavNode[],
  tabs: NavTab[],
  route: string
): NavNode[] => {
  const tab = activeTabForRoute(tabs, route);
  if (tab && tab.path !== "/") {
    return sectionChildren(sidebar, tab.path) ?? [];
  }
  const scoped = withoutTabSections(sidebar, tabs);
  return scoped.length > 0 ? scoped : sidebar;
};

/** Resolve previous/next pages around the current route. */
export const getPagination = (
  flat: FlatPage[],
  route: string
): { prev: FlatPage | null; next: FlatPage | null } => {
  const index = flat.findIndex((page) => page.route === route);
  if (index === -1) {
    return { next: null, prev: null };
  }
  return {
    next: flat[index + 1] ?? null,
    prev: index > 0 ? (flat[index - 1] ?? null) : null,
  };
};

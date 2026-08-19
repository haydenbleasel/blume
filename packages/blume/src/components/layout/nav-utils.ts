import { isRootTab, isUnderPath } from "../../core/navigation.ts";
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
 * The tab to mark as the current one (`aria-current`) for `route`. Same
 * longest-prefix match as {@link activeTabForRoute}, except inside an archived
 * version tree: the root tab claims every archived route through its
 * spans-everything fallback while its link points back at the current docs, so
 * no tab is genuinely current there.
 */
export const currentTabForRoute = (
  tabs: NavTab[],
  route: string,
  root = "/"
): NavTab | null => {
  const tab = activeTabForRoute(tabs, route);
  // The root tab sitting away from the tree root means the tree is a version
  // snapshot in a different path space — the tab matched as a fallback, not
  // because it owns the route.
  if (tab && isRootTab(tab, root) && tab.path !== root) {
    return null;
  }
  return tab;
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
 * spans everything, so it never removes anything.
 */
const withoutTabSections = (
  nodes: NavNode[],
  tabs: NavTab[],
  root: string
): NavNode[] => {
  const tabPaths = new Set<string>();
  for (const tab of tabs) {
    if (!isRootTab(tab, root)) {
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
 * the root tab), the tab-owned groups are hidden so the root sidebar shows
 * only pages that don't belong to a tab.
 *
 * `root` is the tree root (`Navigation.root`), localized and based like tab
 * paths — under i18n or a `basePath` the root tab sits at `/en` or `/docs`,
 * not `/`, and a bare-`/` comparison would misread it as a section tab (a
 * root-level `(group)` folder's path is exactly that prefix, so the sidebar
 * collapsed to that one group or blanked entirely). In an archived version
 * tree the root is versionized (`/v1.0`) while tab paths stay in current-docs
 * space, so root-tab checks use {@link isRootTab} containment, not equality:
 * the root tab owns no group in a snapshot, and misreading it as a section
 * tab blanked the archived sidebar.
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
  route: string,
  root = "/"
): NavNode[] => {
  const tab = activeTabForRoute(tabs, route);
  if (tab && !isRootTab(tab, root)) {
    return sectionChildren(sidebar, tab.path) ?? [];
  }
  const scoped = withoutTabSections(sidebar, tabs, root);
  return scoped.length > 0 ? scoped : sidebar;
};

/** Resolve previous/next pages around the current route. */
export const getPagination = (flat: FlatPage[], route: string) => {
  const index = flat.findIndex((page) => page.route === route);
  if (index === -1) {
    return { next: null, prev: null };
  }
  return {
    next: flat[index + 1] ?? null,
    prev: index > 0 ? (flat[index - 1] ?? null) : null,
  };
};

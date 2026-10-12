import { isRootTab, isUnderPath } from "../../core/navigation.ts";
import type { NavNode, NavTab, Navigation } from "../../core/types.ts";

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

/**
 * Whether a group's header row reads as the current page. A routed group links
 * to its folder's index page; when that index is also listed as one of the
 * group's own rows (kept under a different label), the row is the more
 * specific indicator, so the header stays quiet rather than lighting up beside
 * it. With the index row hidden the header is the only link and takes the
 * highlight.
 */
export const isGroupRowCurrent = (
  group: Extract<NavNode, { kind: "group" }>,
  currentRoute: string
): boolean =>
  group.route === currentRoute &&
  !group.children.some(
    (child) => child.kind === "page" && child.route === currentRoute
  );

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
        // A year (or month) the sidebar folds dated entries into is no
        // section of the site: the trail reads through it.
        const found = search(
          item.children,
          item.period ? trail : [...trail, crumb]
        );
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
 *
 * A group with no tab section anywhere beneath it is kept as the same object:
 * the stable group ids (`navGroupIds`) and the build-time subtree cache are
 * both keyed by node identity, so a copy would lose its id — its collapsed
 * fragment was then requested by a positional name no route serves — and
 * re-render on every page. A container that did lose a section is rebuilt,
 * so it has no id: the deferred fragments render from the full tree, which
 * would put the section back, so `NavTree` renders such a container in full
 * instead (its untouched children still defer by their own ids).
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
        const children = prune(item.children);
        if (
          children.length === item.children.length &&
          children.every((child, index) => child === item.children[index])
        ) {
          kept.push(item);
        } else if (children.length > 0) {
          // A container left empty by pruning is dropped, so no bare heading
          // is stranded.
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

/** A group node in the sidebar tree. */
export type NavGroup = Extract<NavNode, { kind: "group" }>;

/**
 * Whether a `group`-mode disclosure renders open: it holds the current page,
 * its meta forces it open (`collapsed: false`), or it is the only row at the
 * top of the sidebar, where starting closed would leave a sidebar of one row
 * to click before any link shows (a wrapper folder around every page). An
 * explicit `collapsed: true` keeps that lone group closed.
 */
export const groupStartsOpen = (
  group: NavGroup,
  active: boolean,
  lone: boolean
): boolean =>
  active || group.collapsed === false || (lone && group.collapsed !== true);

/**
 * The group whose own page `route` is, when that page lists the group's
 * pages: its `directory` (inherited when the group sets none) is `card` or
 * `accordion`. `null` on every other page.
 */
export const directoryGroupForRoute = (
  nodes: NavNode[],
  route: string
): NavGroup | null => {
  for (const node of nodes) {
    if (node.kind !== "group") {
      continue;
    }
    if (
      node.route === route &&
      (node.directory === "card" || node.directory === "accordion")
    ) {
      return node;
    }
    const nested = directoryGroupForRoute(node.children, route);
    if (nested) {
      return nested;
    }
  }
  return null;
};

/** One entry in a group page's directory: a page, or a subgroup and its pages. */
export interface DirectoryEntry {
  description?: string;
  /** The page, or the subgroup's own page (its first page when it has none). */
  href: string;
  icon?: string;
  label: string;
  /** A subgroup's pages in sidebar order, its own page first; absent for a page. */
  pages?: FlatPage[];
}

/**
 * A group's children, with the year (or month) groups the sidebar folds dated
 * entries into opened up in place: they're no sections of their own.
 */
const unfoldPeriods = (nodes: NavNode[]): NavNode[] =>
  nodes.flatMap((node) =>
    node.kind === "group" && node.period ? node.children : [node]
  );

/**
 * What a group's page lists: the group's pages and subgroups, in sidebar
 * order, without the page itself or external links. A subgroup is described
 * by its own page, and one with no page to link to is left out.
 */
export const directoryEntries = (group: NavGroup): DirectoryEntry[] =>
  unfoldPeriods(group.children).flatMap((child): DirectoryEntry[] => {
    if (child.kind === "page") {
      return child.pageId && child.route !== group.route
        ? [
            {
              description: child.description,
              href: child.route,
              icon: child.icon,
              label: child.label,
            },
          ]
        : [];
    }
    const listed = flattenPages(child.children);
    const pages =
      child.route && !listed.some((page) => page.route === child.route)
        ? [{ label: child.label, route: child.route }, ...listed]
        : listed;
    const [first] = pages;
    if (!first) {
      return [];
    }
    const own = child.children.find(
      (node) => node.kind === "page" && node.route === child.route
    );
    return [
      {
        description: own?.kind === "page" ? own.description : undefined,
        href: child.route ?? first.route,
        icon: child.icon,
        label: child.label,
        pages,
      },
    ];
  });

/**
 * A stable id for every group in a sidebar — `g<n>` by pre-order position in
 * the full tree. The layout hands `NavTree` a scoped view of that tree (a
 * tab's section, or the sidebar minus the tab sections), so positions within
 * the rendered slice differ from page to page; these ids name the same group
 * everywhere, which the drill-in panels and the deferred-section fragments
 * (`/blume-nav/…`) rely on. Keyed by node identity: the scoped views reuse
 * the full tree's node objects.
 */
export const navGroupIds = (sidebar: NavNode[]): Map<NavNode, string> => {
  const ids = new Map<NavNode, string>();
  const walk = (nodes: NavNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "group") {
        ids.set(node, `g${ids.size}`);
        walk(node.children);
      }
    }
  };
  walk(sidebar);
  return ids;
};

/** Whether any group in a sidebar renders as a disclosure or a drill-in panel. */
export const hasDeferrableGroups = (sidebar: NavNode[]): boolean =>
  sidebar.some(
    (node) =>
      node.kind === "group" &&
      ((node.display ?? "flat") !== "flat" ||
        hasDeferrableGroups(node.children))
  );

/** One of the navigation trees a site renders, by URL segment. */
export interface NavVariant {
  /** `current`, or an archived version id. */
  version: string;
  /** `default`, or a locale code. */
  locale: string;
  navigation: Navigation;
}

/**
 * The locale whose code must not appear as a fragment URL segment: the
 * default locale while its URL prefix is hidden. Astro's i18n routing 404s any
 * page URL carrying that locale's code as a segment (it expects the default
 * locale to be unprefixed), so its trees are keyed `default` instead, the same
 * way its page routes drop the prefix. `null` when every locale is prefixed
 * or the site is single-locale.
 */
export const hiddenDefaultLocale = (
  i18n: { defaultLocale: string; hideDefaultLocalePrefix: boolean } | null
): string | null => (i18n?.hideDefaultLocalePrefix ? i18n.defaultLocale : null);

/**
 * Every navigation tree the runtime data holds — the default, each locale's,
 * and each archived version's per locale — keyed the way the deferred
 * sidebar fragments' URLs are (`/blume-nav/<version>/<locale>/…`). An
 * unlocalized version tree is keyed by `""` in the data; it maps to
 * `default` here, as does the hidden-prefix default locale's (see
 * `hiddenDefaultLocale`), whose current tree is `data.navigation` already.
 */
export const navVariants = (
  data: {
    navigation: Navigation;
    navigationByLocale: Record<string, Navigation>;
    navigationByVersion: Record<string, Record<string, Navigation>>;
  },
  hiddenDefault: string | null = null
): NavVariant[] => [
  { locale: "default", navigation: data.navigation, version: "current" },
  ...Object.entries(data.navigationByLocale)
    .filter(([locale]) => locale !== hiddenDefault)
    .map(([locale, navigation]) => ({
      locale,
      navigation,
      version: "current",
    })),
  ...Object.entries(data.navigationByVersion).flatMap(([version, byLocale]) =>
    Object.entries(byLocale).map(([locale, navigation]) => ({
      locale: locale && locale !== hiddenDefault ? locale : "default",
      navigation,
      version,
    }))
  ),
];

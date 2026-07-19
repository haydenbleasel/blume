import { extname } from "pathe";

import { stripBasePath, withBasePath } from "./base-path.ts";
import type {
  FolderMeta,
  SidebarDisplay,
  SidebarItemConfig,
} from "./schema.ts";
import type {
  Diagnostic,
  FeaturedLink,
  NavNode,
  Navigation,
  NavSelector,
  NavTab,
  PageRecord,
} from "./types.ts";

const NUMERIC_PREFIX = /^(?<order>\d+)[-_.]/u;
const GROUP_FOLDER = /^\((?<label>.+)\)$/u;
const WORD_SPLIT = /[-_]/u;

const humanize = (segment: string): string =>
  segment
    .replace(NUMERIC_PREFIX, "")
    .split(WORD_SPLIT)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

const numericOrder = (segment: string): number => {
  const value = segment.match(NUMERIC_PREFIX)?.groups?.order;
  return value ? Math.trunc(Number(value)) : Number.POSITIVE_INFINITY;
};

/** The nav key of a raw path segment: group label or numeric-stripped name. */
const segmentKey = (raw: string): string => {
  const group = raw.match(GROUP_FOLDER)?.groups?.label;
  return (group ?? raw).replace(NUMERIC_PREFIX, "");
};

/**
 * Whether a filename stem is a directory index, ignoring an ordering prefix:
 * route mapping strips the prefix before dropping `index`, so `01-index` routes
 * exactly like `index` and must be treated as one here too.
 */
const isIndexStem = (stem: string): boolean =>
  stem.replace(NUMERIC_PREFIX, "") === "index";

interface MutablePage {
  kind: "page";
  key: string;
  label: string;
  route: string;
  description?: string;
  icon?: string;
  badge?: string;
  deprecated?: boolean;
  pageId: string;
  /** Absolute source path (filesystem adapter only), to anchor diagnostics. */
  file?: string;
  order: number;
  /**
   * Whether `order` reflects a deliberate authoring choice (explicit
   * `sidebar.order`, a numeric filename prefix, or a folder-meta `pages` rank)
   * rather than a derived value like a changelog entry's publish date — two
   * changelog entries published on the same day aren't an authoring mistake,
   * so they're excluded from the duplicate-order diagnostic.
   */
  orderIsAuthored: boolean;
}

interface MutableGroup {
  kind: "group";
  key: string;
  path: string;
  /** The group's URL path (folder route prefix); set as pages are inserted. */
  routePath?: string;
  label: string;
  icon?: string;
  collapsed?: boolean;
  order: number;
  children: MutableNode[];
  index: Map<string, MutableGroup>;
}

type MutableNode = MutablePage | MutableGroup;

const createGroup = (
  key: string,
  path: string,
  label: string,
  order: number
): MutableGroup => ({
  children: [],
  index: new Map(),
  key,
  kind: "group",
  label,
  order,
  path,
});

const ensureGroup = (
  parent: MutableGroup,
  rawSegment: string
): MutableGroup => {
  const existing = parent.index.get(rawSegment);
  if (existing) {
    return existing;
  }
  const path = parent.path ? `${parent.path}/${rawSegment}` : rawSegment;
  const group = createGroup(
    segmentKey(rawSegment),
    path,
    humanize(rawSegment.match(GROUP_FOLDER)?.groups?.label ?? rawSegment),
    numericOrder(rawSegment)
  );
  parent.index.set(rawSegment, group);
  parent.children.push(group);
  return group;
};

const pageOrder = (
  page: PageRecord,
  filename: string
): { order: number; orderIsAuthored: boolean } => {
  if (page.meta.sidebar.order !== undefined) {
    return { order: page.meta.sidebar.order, orderIsAuthored: true };
  }
  if (isIndexStem(filename.replace(extname(filename), ""))) {
    return { order: Number.NEGATIVE_INFINITY, orderIsAuthored: false };
  }
  // Changelog entries read newest-first, matching the generated timeline. Sort
  // on the negated publish timestamp so a later date yields a smaller order
  // under the ascending comparator; undated entries fall back to filename order.
  // The date is derived, not an authoring choice, so same-day entries aren't a
  // duplicate-order mistake.
  if (page.contentType === "changelog") {
    const iso = page.meta.date ?? page.meta.changelog?.date;
    const time = iso ? Date.parse(iso) : Number.NaN;
    if (!Number.isNaN(time)) {
      return { order: -time, orderIsAuthored: false };
    }
  }
  // An undated changelog entry's numeric filename prefix is usually a date
  // (`2024-01-05-release.md`) rather than a rank, so it is derived too.
  const order = numericOrder(filename);
  return {
    order,
    orderIsAuthored: page.contentType !== "changelog" && Number.isFinite(order),
  };
};

/**
 * Folder-meta lookup key for a group path. Under i18n the meta files live in
 * the locale directory (`fr/guides/meta.ts` -> key `fr/guides`) while the
 * nav group path is locale-stripped (`guides`), so prepend the locale prefix.
 */
const metaKey = (path: string, metaPrefix: string): string => {
  if (!metaPrefix) {
    return path;
  }
  return path ? `${metaPrefix}/${path}` : metaPrefix;
};

/** Apply folder meta (title/order/icon/collapsed and explicit page order). */
const applyFolderMeta = (
  group: MutableGroup,
  folderMeta: Map<string, FolderMeta>,
  sharedMeta: Map<string, FolderMeta>,
  metaPrefix: string
): void => {
  // Locale-specific meta wins; a shared `meta.$.*` (keyed by the locale-stripped
  // group path) applies to every locale otherwise.
  const meta =
    folderMeta.get(metaKey(group.path, metaPrefix)) ??
    sharedMeta.get(group.path);
  if (meta) {
    group.label = meta.title ?? group.label;
    group.icon = meta.icon ?? group.icon;
    group.order = meta.order ?? group.order;
    group.collapsed = meta.collapsed ?? group.collapsed;

    if (meta.pages) {
      const rank = new Map(meta.pages.map((key, i) => [key, i]));
      for (const child of group.children) {
        const position = rank.get(child.key);
        if (position !== undefined) {
          child.order = position;
          if (child.kind === "page") {
            child.orderIsAuthored = true;
          }
        }
      }
    }
  }

  for (const child of group.children) {
    if (child.kind === "group") {
      applyFolderMeta(child, folderMeta, sharedMeta, metaPrefix);
    }
  }
};

/**
 * Warn when an index page's own frontmatter title diverges from its folder's
 * explicit `meta.title`. The sidebar label and the page's own `<title>`/heading
 * are resolved from two independent sources — under i18n, a translator can
 * update the folder's `meta.ts` and forget the index page's own frontmatter
 * (or vice versa), and a correct-looking sidebar hides the mismatch.
 *
 * Only fires when the page has an explicit frontmatter `title` of its own:
 * when it's absent, `page.title` is derived from the first heading or the
 * filename, so it almost never coincidentally matches a custom folder title —
 * flagging that would be noise on exactly the plain-landing-page case this is
 * least worth warning about. The root group's `meta.title` (an empty
 * `folderPath`) is also skipped: nothing ever renders it as a sidebar label,
 * so a mismatch there wouldn't correspond to anything visible.
 *
 * Fallback-filled pages are exempt: their title belongs to the fallback
 * locale, so comparing it against this locale's `meta.title` would flag every
 * not-yet-translated index page (once per locale) and point the suggestion at
 * the fallback locale's source file, where "fixing" it would break that
 * locale. The default locale's own build still checks the real page.
 */
const indexTitleMismatchDiagnostic = (
  page: PageRecord,
  folderPath: string,
  folderMeta: Map<string, FolderMeta>,
  sharedMeta: Map<string, FolderMeta>,
  metaPrefix: string
): Diagnostic | undefined => {
  if (!page.meta.title || page.fallback || folderPath === "") {
    return undefined;
  }
  const meta =
    folderMeta.get(metaKey(folderPath, metaPrefix)) ??
    sharedMeta.get(folderPath);
  if (!meta?.title || meta.title === page.title) {
    return undefined;
  }
  return {
    code: "BLUME_NAV_INDEX_TITLE_MISMATCH",
    file: page.sourcePath ?? page.id,
    message: `Index page "${page.navPath}" has title "${page.title}", but its folder's meta.title is "${meta.title}" — the sidebar shows the folder title while the page's own <title>/heading still say "${page.title}".`,
    severity: "warning",
    suggestion: `Update the page's frontmatter title to match ("${meta.title}"), or leave it if the divergence is intentional.`,
  };
};

/** Whether a node's `order` reflects a deliberate authoring choice. */
const isAuthoredOrder = (node: MutableNode): boolean =>
  node.kind === "group" || node.orderIsAuthored;

/**
 * Warn when two sibling nodes share an explicit/numeric order (frontmatter
 * `sidebar.order`, a numeric filename prefix, or folder-meta `order`) — they'd
 * otherwise fall back to a silent, arbitrary alphabetical tiebreak. Nodes at
 * the default fallback order (no numeric prefix, no explicit order) are
 * excluded: that's the common, intentional case of "just sort alphabetically."
 * So is a derived, non-authored order (e.g. two changelog entries published
 * on the same day) — not an authoring mistake.
 */
const duplicateOrderDiagnostics = (nodes: MutableNode[]): Diagnostic[] => {
  const byOrder = new Map<number, MutableNode[]>();
  for (const node of nodes) {
    if (!Number.isFinite(node.order) || !isAuthoredOrder(node)) {
      continue;
    }
    const tied = byOrder.get(node.order);
    if (tied) {
      tied.push(node);
    } else {
      byOrder.set(node.order, [node]);
    }
  }
  const diagnostics: Diagnostic[] = [];
  for (const [order, tied] of byOrder) {
    if (tied.length > 1) {
      const names = tied.map((node) => `"${node.label}"`);
      const list =
        names.length > 2
          ? `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`
          : names.join(" and ");
      const verb = tied.length > 2 ? "all have" : "both have";
      // Anchor the diagnostic to one tied source file so tooling can point
      // somewhere concrete; the message names the rest. Folder-only ties
      // (folder-meta `order`) have no single file, so `file` stays unset.
      const file = tied.find(
        (node): node is MutablePage => node.kind === "page"
      )?.file;
      diagnostics.push({
        code: "BLUME_DUPLICATE_SIDEBAR_ORDER",
        file,
        message: `${list} ${verb} sidebar order ${order}; falling back to alphabetical order.`,
        severity: "warning",
        suggestion:
          "Give each item a distinct sidebar.order (or folder meta order).",
      });
    }
  }
  return diagnostics;
};

const sortNodes = (nodes: MutableNode[], diagnostics: Diagnostic[]): void => {
  diagnostics.push(...duplicateOrderDiagnostics(nodes));
  nodes.sort((a, b) => {
    if (a.order !== b.order) {
      return a.order - b.order;
    }
    return a.label.localeCompare(b.label);
  });
  for (const node of nodes) {
    if (node.kind === "group") {
      sortNodes(node.children, diagnostics);
    }
  }
};

/**
 * Hoist loose pages above groups so root-level pages read as top-level entries
 * rather than a group's trailing children (relative order otherwise preserved).
 * All display modes hoist the root level. Flat additionally recurses into every
 * group: there a group renders as a plain section header, so a loose page sorted
 * after a group would visually read as that group's last child.
 */
const hoistPages = (nodes: MutableNode[], recurse: boolean): void => {
  const pages = nodes.filter((node) => node.kind === "page");
  const groups = nodes.filter((node) => node.kind === "group");
  nodes.splice(0, nodes.length, ...pages, ...groups);
  if (recurse) {
    for (const group of groups) {
      hoistPages(group.children, recurse);
    }
  }
};

/**
 * With tabs configured, the sidebar shown under a tab is that tab-section
 * group's *children*, not the tree root — so hoisting only the root leaves a
 * tab section's loose pages interleaved with its groups. Hoist the top level of
 * every group that owns a tab (matched on its URL path), mirroring the root.
 */
const hoistTabSections = (
  nodes: MutableNode[],
  tabPaths: Set<string>,
  recurse: boolean
): void => {
  for (const node of nodes) {
    if (node.kind !== "group") {
      continue;
    }
    if (node.routePath !== undefined && tabPaths.has(node.routePath)) {
      hoistPages(node.children, recurse);
    }
    hoistTabSections(node.children, tabPaths, recurse);
  }
};

const toNavNode = (node: MutableNode, display: SidebarDisplay): NavNode => {
  if (node.kind === "page") {
    return {
      badge: node.badge,
      deprecated: node.deprecated || undefined,
      description: node.description,
      icon: node.icon,
      kind: "page",
      label: node.label,
      pageId: node.pageId,
      route: node.route,
    };
  }
  return {
    children: node.children.map((child) => toNavNode(child, display)),
    collapsed: node.collapsed,
    display,
    icon: node.icon,
    kind: "group",
    label: node.label,
    path: node.routePath,
  };
};

/** Build the sidebar tree from the file system and folder meta. */
const buildFileSystemSidebar = (
  pages: PageRecord[],
  folderMeta: Map<string, FolderMeta>,
  sharedMeta: Map<string, FolderMeta>,
  metaPrefix: string,
  display: SidebarDisplay,
  tabPaths: Set<string>,
  diagnostics: Diagnostic[] = []
): NavNode[] => {
  const root = createGroup("", "", "", 0);

  for (const page of pages) {
    // Group by the locale-stripped path so the locale dir is not a nav group.
    const parts = page.navPath.split("/");
    const filename = parts.at(-1) ?? page.navPath;
    const stem = filename.replace(extname(filename), "");
    const dirs = parts.slice(0, -1);

    // Checked before the hidden filter: a sidebar-hidden index page still
    // renders with its own <title>, so title drift matters there just the same.
    if (isIndexStem(stem)) {
      const diagnostic = indexTitleMismatchDiagnostic(
        page,
        dirs.join("/"),
        folderMeta,
        sharedMeta,
        metaPrefix
      );
      if (diagnostic) {
        diagnostics.push(diagnostic);
      }
    }

    if (page.meta.sidebar.hidden) {
      continue;
    }

    // Each group's URL path is the matching prefix of the page's route. navPath
    // is locale-stripped while the route may carry a locale/base prefix, so
    // align the folder segments from the right (the extra leading segments are
    // that prefix). Under such a prefix the path won't match a logical tab path,
    // so tab-scoping simply no-ops — same as the header's active-tab logic.
    // An index page's route IS its folder's route (no page segment to drop),
    // and `(group)` folders contribute no route segment at all.
    const routeSegments = page.route.split("/").filter(Boolean);
    const folderParts = isIndexStem(stem)
      ? routeSegments
      : routeSegments.slice(0, -1);
    const routeDirCount = dirs.filter((dir) => !GROUP_FOLDER.test(dir)).length;
    const offset = Math.max(0, folderParts.length - routeDirCount);

    let parent = root;
    let consumed = offset;
    for (const dir of dirs) {
      parent = ensureGroup(parent, dir);
      if (!GROUP_FOLDER.test(dir)) {
        consumed += 1;
      }
      parent.routePath ??= `/${folderParts.slice(0, consumed).join("/")}`;
    }

    const { order, orderIsAuthored } = pageOrder(page, filename);
    parent.children.push({
      badge: page.meta.sidebar.badge,
      deprecated: page.meta.deprecated || undefined,
      description: page.description,
      file: page.sourcePath,
      icon: page.meta.sidebar.icon,
      key: segmentKey(stem),
      kind: "page",
      label: page.meta.sidebar.label ?? page.title,
      order,
      orderIsAuthored,
      pageId: page.id,
      route: page.route,
    });
  }

  applyFolderMeta(root, folderMeta, sharedMeta, metaPrefix);
  sortNodes(root.children, diagnostics);
  hoistPages(root.children, display === "flat");
  hoistTabSections(root.children, tabPaths, display === "flat");
  return root.children.map((child) => toNavNode(child, display));
};

const normalizeRef = (ref: string): string => {
  if (ref === "index") {
    return "/";
  }
  const withSlash = ref.startsWith("/") ? ref : `/${ref}`;
  const trimmed = withSlash.endsWith("/index")
    ? withSlash.slice(0, -"/index".length)
    : withSlash;
  // "/index" trims to "" — that's the root, not an empty route.
  return trimmed === "" ? "/" : trimmed;
};

const routeForRef = (
  ref: string | undefined,
  byRoute: Map<string, PageRecord>,
  basePath: string
): string | undefined => {
  if (!ref) {
    return undefined;
  }
  const normalized = normalizeRef(ref);
  // A matched page carries an already-based `route`; an unmatched ref is an
  // author-written root-relative path that still needs the base applied.
  return byRoute.get(normalized)?.route ?? withBasePath(basePath, normalized);
};

/**
 * Convert one non-group explicit-config sidebar item (string ref, `root`, or
 * `href`) to a nav node, or null to skip. Group items (`item.items`) are handled
 * by `buildConfigSidebar` itself so it owns the recursion.
 */
const configItemToNode = (
  item: SidebarItemConfig,
  byRoute: Map<string, PageRecord>,
  basePath: string
): NavNode | null => {
  if (typeof item === "string") {
    const page = byRoute.get(normalizeRef(item));
    if (!page) {
      return null;
    }
    return {
      badge: page.meta.sidebar.badge,
      deprecated: page.meta.deprecated || undefined,
      description: page.description,
      icon: page.meta.sidebar.icon,
      kind: "page",
      label: page.meta.sidebar.label ?? page.title,
      pageId: page.id,
      route: page.route,
    };
  }

  if (item.root) {
    const page = byRoute.get(normalizeRef(item.root));
    return {
      badge: item.badge,
      deprecated: page?.meta.deprecated || undefined,
      icon: item.icon,
      kind: "page",
      label: item.label,
      pageId: page?.id ?? "",
      route: page?.route ?? withBasePath(basePath, normalizeRef(item.root)),
    };
  }

  if (item.href) {
    return {
      badge: item.badge,
      icon: item.icon,
      kind: "page",
      label: item.label,
      pageId: "",
      route: withBasePath(basePath, item.href),
    };
  }

  return null;
};

/** Build the sidebar tree from an explicit config spec. */
const buildConfigSidebar = (
  items: SidebarItemConfig[],
  byRoute: Map<string, PageRecord>,
  display: SidebarDisplay,
  basePath: string
): NavNode[] => {
  const nodes: NavNode[] = [];
  for (const item of items) {
    if (typeof item !== "string" && item.items) {
      nodes.push({
        badge: item.badge,
        children: buildConfigSidebar(item.items, byRoute, display, basePath),
        collapsed: item.collapsed,
        directory: item.directory,
        display: item.display ?? display,
        icon: item.icon,
        kind: "group",
        label: item.label,
        route: routeForRef(item.root, byRoute, basePath),
      });
      continue;
    }
    const node = configItemToNode(item, byRoute, basePath);
    if (node) {
      nodes.push(node);
    }
  }
  return nodes;
};

/**
 * Resolve a tab's clickable target. A tab's `path` scopes its sidebar section
 * but need not be a real route — a section with no index page would 404 if the
 * tab linked straight to it. Prefer an exact page/group at the path; otherwise
 * fall back to the first linkable route in the section (sidebar order).
 */
const resolveTabHref = (sidebar: NavNode[], path: string): string => {
  let first: string | undefined;
  const walk = (nodes: NavNode[]): boolean => {
    for (const node of nodes) {
      const { route } = node;
      if (route === path) {
        return true;
      }
      if (
        first === undefined &&
        route !== undefined &&
        route.startsWith(`${path}/`)
      ) {
        first = route;
      }
      if (node.kind === "group" && walk(node.children)) {
        return true;
      }
    }
    return false;
  };
  return walk(sidebar) ? path : (first ?? path);
};

/** Attach a resolved `href` to each tab whose section has no index page. */
const withTabHrefs = (tabs: NavTab[], sidebar: NavNode[]): NavTab[] =>
  tabs.map((tab) => {
    const href = resolveTabHref(sidebar, tab.path);
    return href === tab.path ? tab : { ...tab, href };
  });

/** Build the complete navigation model from pages, meta, and config. */
export const buildNavigation = (
  pages: PageRecord[],
  options: {
    /** Site-wide route mount point (`""` or `/seg`); applied to config paths. */
    basePath?: string;
    folderMeta: Map<string, FolderMeta>;
    /** Global display mode for every sidebar group (default `flat`). */
    display?: SidebarDisplay;
    featured?: FeaturedLink[];
    selectors?: NavSelector[];
    tabs?: NavTab[];
    sidebar?: SidebarItemConfig[];
    /** Locale dir prefix for folder-meta lookup (`""` for the default locale). */
    metaPrefix?: string;
    /**
     * Resolve explicit-sidebar references against each page's locale-agnostic
     * `translationKey` instead of its localized `route`. Used under i18n so a
     * single authored sidebar maps onto every locale's pages.
     */
    refByLogical?: boolean;
    /** Shared `meta.$.*` meta, keyed by locale-stripped dir path. */
    sharedFolderMeta?: Map<string, FolderMeta>;
    /**
     * The tree's root route before `basePath` (`"/"`, or the locale prefix
     * under i18n, e.g. `/fr` — tab paths arrive already localized). The tab
     * pointing here spans the whole tree, so it is excluded from tab-section
     * scoping.
     */
    localizedRoot?: string;
    /**
     * Sink for diagnostics produced while building the tree (duplicate sidebar
     * `order` values, index-page title/folder-meta-title mismatches). Pushed
     * into in place; omit to discard.
     */
    diagnostics?: Diagnostic[];
  }
): Navigation => {
  const basePath = options.basePath ?? "";
  const display = options.display ?? "flat";
  const metaPrefix = options.metaPrefix ?? "";
  const sharedFolderMeta = options.sharedFolderMeta ?? new Map();

  // Config-provided nav paths are authored as if mounted at root, so the base
  // is applied here (idempotently, and only to internal paths — external URLs
  // pass through). Content-derived sidebar routes are already based via
  // `page.route`. The based tab paths also feed tab-scoping below, so they must
  // agree with the based content routes. With no base, this is a pure pass-
  // through — the arrays keep their exact authored shape.
  const rebasePath = <T extends { path: string }>(item: T): T => ({
    ...item,
    path: withBasePath(basePath, item.path),
  });
  const featured = basePath
    ? (options.featured ?? []).map((link) => ({
        ...link,
        href: withBasePath(basePath, link.href),
      }))
    : (options.featured ?? []);
  const selectors = basePath
    ? (options.selectors ?? []).map((selector) => ({
        ...selector,
        items: selector.items.map(rebasePath),
      }))
    : (options.selectors ?? []);
  const tabs = basePath
    ? (options.tabs ?? []).map((tab) => ({
        ...tab,
        items: tab.items?.map(rebasePath),
        path: withBasePath(basePath, tab.path),
      }))
    : (options.tabs ?? []);
  const byRoute = new Map(
    pages.map((page) => [
      options.refByLogical ? page.translationKey : page.route,
      page,
    ])
  );
  // Explicit-sidebar refs (`"foo/index"`) are authored as if mounted at root,
  // but `page.route` carries the base — alias each page under its base-less
  // route so a bare ref still resolves. (The i18n `refByLogical` map is already
  // keyed by the base-less `translationKey`, so it needs no alias.)
  if (basePath && !options.refByLogical) {
    for (const page of pages) {
      const bare = stripBasePath(basePath, page.route);
      if (!byRoute.has(bare)) {
        byRoute.set(bare, page);
      }
    }
  }

  if (options.sidebar) {
    const sidebar = buildConfigSidebar(
      options.sidebar,
      byRoute,
      display,
      basePath
    );
    return {
      featured,
      selectors,
      sidebar,
      tabs: withTabHrefs(tabs, sidebar),
    };
  }

  // A tab pointing at the tree root spans the whole sidebar rather than one
  // section, so it must not feed tab-section hoisting. `tabs` carries final
  // paths (localized, then based), so the root is compared in the same space —
  // a root-level `(group)` folder's routePath is exactly the based/localized
  // prefix (`/docs`, `/fr`) and a bare `"/"` check would miss the match (or,
  // under a base, falsely scope a group named like the prefix).
  const rootTabPath = withBasePath(basePath, options.localizedRoot ?? "/");
  const sidebar = buildFileSystemSidebar(
    pages,
    options.folderMeta,
    sharedFolderMeta,
    metaPrefix,
    display,
    new Set(
      tabs.flatMap((tab) => (tab.path === rootTabPath ? [] : [tab.path]))
    ),
    options.diagnostics
  );
  return {
    featured,
    selectors,
    sidebar,
    tabs: withTabHrefs(tabs, sidebar),
  };
};

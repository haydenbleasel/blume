import { extname } from "pathe";

import type {
  FolderMeta,
  SidebarDisplay,
  SidebarItemConfig,
} from "./schema.ts";
import type {
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
  return value ? Number.parseInt(value, 10) : Number.POSITIVE_INFINITY;
};

/** The nav key of a raw path segment: group label or numeric-stripped name. */
const segmentKey = (raw: string): string => {
  const group = raw.match(GROUP_FOLDER)?.groups?.label;
  return (group ?? raw).replace(NUMERIC_PREFIX, "");
};

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
  order: number;
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

const pageOrder = (page: PageRecord, filename: string): number => {
  if (page.meta.sidebar.order !== undefined) {
    return page.meta.sidebar.order;
  }
  if (filename.replace(extname(filename), "") === "index") {
    return Number.NEGATIVE_INFINITY;
  }
  return numericOrder(filename);
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

const sortNodes = (nodes: MutableNode[]): void => {
  nodes.sort((a, b) => {
    if (a.order !== b.order) {
      return a.order - b.order;
    }
    return a.label.localeCompare(b.label);
  });
  for (const node of nodes) {
    if (node.kind === "group") {
      sortNodes(node.children);
    }
  }
};

/**
 * In flat display a group renders as a plain section header, so a loose page
 * sorted after a group would visually read as that group's last child. Hoist
 * pages above groups at every level (relative order otherwise preserved).
 */
const hoistPages = (nodes: MutableNode[]): void => {
  const pages = nodes.filter((node) => node.kind === "page");
  const groups = nodes.filter((node) => node.kind === "group");
  nodes.splice(0, nodes.length, ...pages, ...groups);
  for (const group of groups) {
    hoistPages(group.children);
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
  display: SidebarDisplay
): NavNode[] => {
  const root = createGroup("", "", "", 0);

  for (const page of pages) {
    if (page.meta.sidebar.hidden) {
      continue;
    }
    // Group by the locale-stripped path so the locale dir is not a nav group.
    const parts = page.navPath.split("/");
    const filename = parts.at(-1) ?? page.navPath;
    const stem = filename.replace(extname(filename), "");
    const dirs = parts.slice(0, -1);

    // Each group's URL path is the matching prefix of the page's route. navPath
    // is locale-stripped while the route may carry a locale/base prefix, so
    // align the folder segments from the right (the extra leading segments are
    // that prefix). Under such a prefix the path won't match a logical tab path,
    // so tab-scoping simply no-ops — same as the header's active-tab logic.
    // An index page's route IS its folder's route (no page segment to drop),
    // and `(group)` folders contribute no route segment at all.
    const routeSegments = page.route.split("/").filter(Boolean);
    const folderParts =
      stem === "index" ? routeSegments : routeSegments.slice(0, -1);
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

    parent.children.push({
      badge: page.meta.sidebar.badge,
      deprecated: page.meta.deprecated || undefined,
      description: page.description,
      icon: page.meta.sidebar.icon,
      key: segmentKey(stem),
      kind: "page",
      label: page.meta.sidebar.label ?? page.title,
      order: pageOrder(page, filename),
      pageId: page.id,
      route: page.route,
    });
  }

  applyFolderMeta(root, folderMeta, sharedMeta, metaPrefix);
  sortNodes(root.children);
  if (display === "flat") {
    hoistPages(root.children);
  }
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
  byRoute: Map<string, PageRecord>
): string | undefined => {
  if (!ref) {
    return undefined;
  }
  const normalized = normalizeRef(ref);
  return byRoute.get(normalized)?.route ?? normalized;
};

/** Build the sidebar tree from an explicit config spec. */
const buildConfigSidebar = (
  items: SidebarItemConfig[],
  byRoute: Map<string, PageRecord>,
  display: SidebarDisplay
): NavNode[] => {
  const nodes: NavNode[] = [];

  for (const item of items) {
    if (typeof item === "string") {
      const page = byRoute.get(normalizeRef(item));
      if (page) {
        nodes.push({
          badge: page.meta.sidebar.badge,
          deprecated: page.meta.deprecated || undefined,
          description: page.description,
          icon: page.meta.sidebar.icon,
          kind: "page",
          label: page.meta.sidebar.label ?? page.title,
          pageId: page.id,
          route: page.route,
        });
      }
      continue;
    }

    if (item.items) {
      nodes.push({
        badge: item.badge,
        children: buildConfigSidebar(item.items, byRoute, display),
        collapsed: item.collapsed,
        directory: item.directory,
        display: item.display ?? display,
        icon: item.icon,
        kind: "group",
        label: item.label,
        route: routeForRef(item.root, byRoute),
      });
      continue;
    }

    if (item.root) {
      const page = byRoute.get(normalizeRef(item.root));
      nodes.push({
        badge: item.badge,
        deprecated: page?.meta.deprecated || undefined,
        icon: item.icon,
        kind: "page",
        label: item.label,
        pageId: page?.id ?? "",
        route: page?.route ?? normalizeRef(item.root),
      });
      continue;
    }

    if (item.href) {
      nodes.push({
        badge: item.badge,
        icon: item.icon,
        kind: "page",
        label: item.label,
        pageId: "",
        route: item.href,
      });
    }
  }

  return nodes;
};

/** Build the complete navigation model from pages, meta, and config. */
export const buildNavigation = (
  pages: PageRecord[],
  options: {
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
  }
): Navigation => {
  const featured = options.featured ?? [];
  const selectors = options.selectors ?? [];
  const tabs = options.tabs ?? [];
  const display = options.display ?? "flat";
  const metaPrefix = options.metaPrefix ?? "";
  const sharedFolderMeta = options.sharedFolderMeta ?? new Map();
  const byRoute = new Map(
    pages.map((page) => [
      options.refByLogical ? page.translationKey : page.route,
      page,
    ])
  );

  if (options.sidebar) {
    return {
      featured,
      selectors,
      sidebar: buildConfigSidebar(options.sidebar, byRoute, display),
      tabs,
    };
  }

  return {
    featured,
    selectors,
    sidebar: buildFileSystemSidebar(
      pages,
      options.folderMeta,
      sharedFolderMeta,
      metaPrefix,
      display
    ),
    tabs,
  };
};

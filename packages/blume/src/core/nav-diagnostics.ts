import { isAssetIcon } from "../theme/icon-kind.ts";
import { hasIcon } from "../theme/icons.ts";
import { isInternalPath } from "./base-path.ts";
import { resolveLocalizable } from "./localizable.ts";
import { isBuiltInMcpClient } from "./mcp-clients.ts";
import type { McpClientEntry } from "./mcp-clients.ts";
import { isPageRef, normalizeRef } from "./navigation.ts";
import type { SidebarItemConfig } from "./schema.ts";
import type { Diagnostic, NavNode, Navigation, PageRecord } from "./types.ts";

/**
 * Navigation diagnostics: catch icon typos and structural mistakes (missing
 * pages, duplicate labels) that otherwise fail silently — a wrong icon just
 * doesn't render, a bad tab path just 404s. Run over the built navigation so it
 * covers every source (config, folder meta, frontmatter) at once.
 */

const ICON_FORMAT_HINT =
  "Use a built-in icon name, an image path/URL, or inline SVG markup.";

/** Flatten a sidebar tree to every node, descending into groups. */
const flattenNodes = (nodes: NavNode[]): NavNode[] =>
  nodes.flatMap((node) =>
    node.kind === "group" ? [node, ...flattenNodes(node.children)] : [node]
  );

/** Every icon string referenced anywhere in the navigation, with a label. */
const collectIcons = (
  navigation: Navigation
): { icon: string; where: string }[] => {
  const icons: { icon: string; where: string }[] = [];
  const push = (icon: string | undefined, where: string): void => {
    if (icon) {
      icons.push({ icon, where });
    }
  };
  for (const tab of navigation.tabs) {
    push(tab.icon, `tab "${tab.label}"`);
    for (const item of tab.items ?? []) {
      push(item.icon, `tab item "${item.label}"`);
    }
  }
  for (const selector of navigation.selectors) {
    for (const item of selector.items) {
      push(item.icon, `selector "${item.label}"`);
    }
  }
  for (const link of navigation.featured) {
    push(link.icon, `featured link "${link.label}"`);
  }
  const sidebars = [navigation.sidebar];
  for (const sidebar of sidebars) {
    for (const node of flattenNodes(sidebar)) {
      push(node.icon, `"${node.label}"`);
    }
  }
  return icons;
};

/** Warn about icon names that aren't in Blume's set (skipping image/SVG icons). */
const unknownIconDiagnostics = (
  icons: { icon: string; where: string }[],
  suggestion: string
): Diagnostic[] => {
  const seen = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  for (const { icon, where } of icons) {
    if (isAssetIcon(icon) || hasIcon(icon) || seen.has(icon)) {
      continue;
    }
    seen.add(icon);
    // Markup that isn't a complete <svg> element (an <img> tag, a truncated
    // svg) is a shape problem, not a set-name typo — say so.
    const message = icon.trimStart().startsWith("<")
      ? `Icon markup "${icon}" (${where}) isn't a complete inline <svg> element, so it won't render.`
      : `Unknown icon "${icon}" (${where}) — it isn't in Blume's icon set.`;
    diagnostics.push({
      code: "BLUME_UNKNOWN_ICON",
      message,
      severity: "warning",
      suggestion,
    });
  }
  return diagnostics;
};

/** Warn about icon names that aren't in Blume's set (skipping image/SVG icons). */
export const validateNavIcons = (navigation: Navigation): Diagnostic[] =>
  unknownIconDiagnostics(collectIcons(navigation), ICON_FORMAT_HINT);

/**
 * Warn about unknown icons on curated `search.popular` links. Same accepted
 * input shapes as nav icons — resolved to markup on the server for the island.
 */
export const validateSearchPopularIcons = (
  popular: { icon?: string; label: string }[]
): Diagnostic[] => {
  const icons = popular.flatMap((link) =>
    link.icon
      ? [{ icon: link.icon, where: `popular link "${link.label}"` }]
      : []
  );
  return unknownIconDiagnostics(icons, ICON_FORMAT_HINT);
};

/**
 * Warn about unknown icons on custom "Connect to MCP" clients
 * (`agents.mcp.clients`), which live outside the navigation model too. A
 * per-locale label is named in the default locale.
 */
export const validateMcpClientIcons = (
  clients: readonly McpClientEntry[],
  defaultLocale?: string
): Diagnostic[] => {
  const icons = clients.flatMap((client) =>
    !isBuiltInMcpClient(client) && client.icon
      ? [
          {
            icon: client.icon,
            where: `MCP client "${resolveLocalizable(client.label, defaultLocale, defaultLocale)}"`,
          },
        ]
      : []
  );
  return unknownIconDiagnostics(icons, ICON_FORMAT_HINT);
};

/** Whether an internal path resolves to a page or a section that has pages. */
const resolvesToPages = (routes: Set<string>, path: string): boolean =>
  routes.has(path) || [...routes].some((route) => route.startsWith(`${path}/`));

/**
 * Warn when a config-linked tab/selector target has no matching page. `routes`
 * must be the full set of servable routes — content, custom `.astro` pages, and
 * generated routes — so this runs where all three are known (`generateRuntime`),
 * not in the content-only graph build. `servesFile` answers for the files the
 * site serves beside its pages — `public/` and the generated ones (see
 * `staticFileResolver`) — so a featured link to `/spec.pdf` or `/llms.txt`
 * resolves too.
 *
 * A tab is checked where it links: its `href` — the author's, or the
 * section's first page that navigation resolved for a `path` with no page of
 * its own — and its `path` only when it links there.
 */
export const validateNavTargets = (
  navigation: Navigation,
  routes: Set<string>,
  servesFile: (path: string) => boolean = () => false
): Diagnostic[] => {
  const targets: { label: string; path: string }[] = [
    ...navigation.tabs.map((tab) => ({
      label: tab.label,
      path: tab.href ?? tab.path,
    })),
    ...navigation.selectors.flatMap((selector) =>
      selector.items.map((item) => ({ label: item.label, path: item.path }))
    ),
    ...navigation.featured.map((link) => ({
      label: link.label,
      path: link.href,
    })),
    ...(navigation.actions ?? []).map((action) => ({
      label: action.label,
      path: action.href,
    })),
    ...(navigation.cta
      ? [{ label: navigation.cta.label, path: navigation.cta.href }]
      : []),
  ];
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const { label, path } of targets) {
    // Only internal, non-anchor paths can be checked against routes. A
    // protocol-relative `//host/path` is external despite its leading slash.
    if (!isInternalPath(path) || path.startsWith("/#") || seen.has(path)) {
      continue;
    }
    // A query or fragment (`/guides?tab=cli`) rides on the route; only the
    // path names a page.
    const bare = path.split(/[?#]/u)[0] ?? path;
    if (!(resolvesToPages(routes, bare) || servesFile(bare))) {
      seen.add(path);
      diagnostics.push({
        code: "BLUME_NAV_MISSING_PAGE",
        message: `Navigation entry "${label}" points to ${path}, but no page matches it.`,
        severity: "warning",
        suggestion: "Fix the path, or add a page at that route.",
      });
    }
  }
  return diagnostics;
};

/**
 * Warn about explicit `navigation.sidebar` items that can't render as written,
 * instead of dropping them without a word: a page ref that matches no page
 * (left out of the sidebar), a `root` that matches no page (its link leads
 * nowhere), and an item with no page, `href`, `root`, or `items` (left out).
 * `resolves` answers whether a normalized ref (`/guides`) names a page — in
 * any locale — or a route served outside the content tree.
 */
export const validateSidebarItems = (
  items: SidebarItemConfig[],
  resolves: (route: string) => boolean
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const walk = (list: SidebarItemConfig[]): void => {
    for (const item of list) {
      if (isPageRef(item)) {
        if (!resolves(normalizeRef(item))) {
          diagnostics.push({
            code: "BLUME_NAV_MISSING_PAGE",
            message: `Sidebar entry "${item}" matches no page, so it's left out of the sidebar.`,
            severity: "warning",
            suggestion: "Fix the route, or add a page at it.",
          });
        }
        continue;
      }
      if (item.root && !resolves(normalizeRef(item.root))) {
        diagnostics.push({
          code: "BLUME_NAV_MISSING_PAGE",
          message: `Sidebar entry "${item.label}" has root "${item.root}", but no page matches it, so its link leads nowhere.`,
          severity: "warning",
          suggestion: "Fix the root, or add a page at that route.",
        });
      }
      if (item.items) {
        walk(item.items);
      } else if (!(item.root || item.href)) {
        diagnostics.push({
          code: "BLUME_NAV_EMPTY_ITEM",
          message: `Sidebar entry "${item.label}" has no page, href, root, or items, so it's left out of the sidebar.`,
          severity: "warning",
          suggestion:
            "Give it an href or a root to link somewhere, or items to make it a group.",
        });
      }
    }
  };
  walk(items);
  return diagnostics;
};

/** Warn about two nav items sharing a label at the same sidebar level. */
const duplicateLabelDiagnostics = (navigation: Navigation): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const checkLevel = (nodes: NavNode[], where: string): void => {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      counts.set(node.label, (counts.get(node.label) ?? 0) + 1);
    }
    for (const [label, count] of counts) {
      if (count > 1) {
        diagnostics.push({
          code: "BLUME_NAV_DUPLICATE_LABEL",
          message: `Duplicate sidebar label "${label}" appears ${count} times ${where}.`,
          severity: "warning",
          suggestion: "Give the entries distinct titles.",
        });
      }
    }
    for (const node of nodes) {
      if (node.kind === "group") {
        checkLevel(node.children, `under "${node.label}"`);
      }
    }
  };
  const sidebars: { nodes: NavNode[]; where: string }[] = [
    { nodes: navigation.sidebar, where: "at the top level" },
  ];
  for (const { nodes, where } of sidebars) {
    checkLevel(nodes, where);
  }
  return diagnostics;
};

/** Warn when a page shown in the sidebar is marked hidden (so pagination hits it). */
const hiddenInSidebarDiagnostics = (
  navigation: Navigation,
  pages: PageRecord[]
): Diagnostic[] => {
  const hidden = new Set(
    pages.flatMap((page) => (page.meta.sidebar.hidden ? [page.id] : []))
  );
  if (hidden.size === 0) {
    return [];
  }
  const sidebars = [navigation.sidebar];
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const sidebar of sidebars) {
    for (const node of flattenNodes(sidebar)) {
      if (
        node.kind === "page" &&
        hidden.has(node.pageId) &&
        !seen.has(node.pageId)
      ) {
        seen.add(node.pageId);
        diagnostics.push({
          code: "BLUME_NAV_HIDDEN_IN_SIDEBAR",
          message: `Page "${node.label}" is marked hidden but appears in the sidebar (and its pagination).`,
          severity: "warning",
          suggestion:
            "Remove it from the navigation config, or unset sidebar.hidden.",
        });
      }
    }
  }
  return diagnostics;
};

/**
 * Structural navigation diagnostics that need only the built navigation +
 * content pages: duplicate sidebar labels at a level, and hidden pages that
 * still surface in the sidebar (so pagination lands on them). Target existence
 * is checked separately by {@link validateNavTargets}, which needs the full
 * route set.
 */
export const validateNavStructure = (
  navigation: Navigation,
  pages: PageRecord[]
): Diagnostic[] => [
  ...duplicateLabelDiagnostics(navigation),
  ...hiddenInSidebarDiagnostics(navigation, pages),
];

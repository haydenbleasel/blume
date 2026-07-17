import { hasIcon } from "../theme/icons.ts";
import type { Diagnostic, NavNode, Navigation, PageRecord } from "./types.ts";

/**
 * Navigation diagnostics: catch icon typos and structural mistakes (missing
 * pages, duplicate labels) that otherwise fail silently — a wrong icon just
 * doesn't render, a bad tab path just 404s. Run over the built navigation so it
 * covers every source (config, folder meta, frontmatter) at once.
 */

const IMAGE_ICON =
  /^(?:https?:\/\/|data:image\/|\/|\.{1,2}\/)|\.(?:avif|gif|jpe?g|png|svg|webp)$/iu;

/** Whether an icon string is an asset (image/URL/inline SVG), not a set name. */
const isAssetIcon = (value: string): boolean =>
  value.startsWith("<") || IMAGE_ICON.test(value);

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
    diagnostics.push({
      code: "BLUME_UNKNOWN_ICON",
      message: `Unknown icon "${icon}" (${where}) — it isn't in Blume's icon set.`,
      severity: "warning",
      suggestion,
    });
  }
  return diagnostics;
};

/** Warn about icon names that aren't in Blume's set (skipping image/SVG icons). */
export const validateNavIcons = (navigation: Navigation): Diagnostic[] =>
  unknownIconDiagnostics(
    collectIcons(navigation),
    "Use a built-in icon name, an image path/URL, or inline SVG markup."
  );

/**
 * Warn about unknown icons on curated `search.popular` links. Separate from
 * {@link validateNavIcons} because these live under `search`, not the built
 * navigation — and unlike nav icons they resolve in a *client* island, so only
 * set names work (an image/SVG icon quietly falls back to the file glyph).
 */
export const validateSearchPopularIcons = (
  popular: { icon?: string; label: string }[]
): Diagnostic[] =>
  unknownIconDiagnostics(
    popular.flatMap((link) =>
      link.icon
        ? [{ icon: link.icon, where: `popular link "${link.label}"` }]
        : []
    ),
    "Use a built-in icon name."
  );

/** Whether an internal path resolves to a page or a section that has pages. */
const resolvesToPages = (routes: Set<string>, path: string): boolean =>
  routes.has(path) || [...routes].some((route) => route.startsWith(`${path}/`));

/**
 * Warn when a config-linked tab/selector target has no matching page. `routes`
 * must be the full set of servable routes — content, custom `.astro` pages, and
 * generated routes — so this runs where all three are known (`generateRuntime`),
 * not in the content-only graph build.
 */
export const validateNavTargets = (
  navigation: Navigation,
  routes: Set<string>
): Diagnostic[] => {
  const targets: { label: string; path: string }[] = [
    ...navigation.tabs.map((tab) => ({ label: tab.label, path: tab.path })),
    ...navigation.selectors.flatMap((selector) =>
      selector.items.map((item) => ({ label: item.label, path: item.path }))
    ),
    ...navigation.featured.map((link) => ({
      label: link.label,
      path: link.href,
    })),
  ];
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const { label, path } of targets) {
    // Only internal, non-anchor paths can be checked against routes.
    if (!path.startsWith("/") || path.startsWith("/#") || seen.has(path)) {
      continue;
    }
    if (!resolvesToPages(routes, path.split("#")[0] ?? path)) {
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

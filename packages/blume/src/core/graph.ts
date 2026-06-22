import { extname } from "pathe";

import type {
  ContentGraph,
  Diagnostic,
  NavNode,
  Navigation,
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

interface MutablePage {
  kind: "page";
  label: string;
  route: string;
  icon?: string;
  badge?: string;
  pageId: string;
  order: number;
}

interface MutableGroup {
  kind: "group";
  label: string;
  icon?: string;
  collapsed?: boolean;
  order: number;
  children: MutableNode[];
  index: Map<string, MutableGroup>;
}

type MutableNode = MutablePage | MutableGroup;

const createGroup = (label: string, order: number): MutableGroup => ({
  children: [],
  index: new Map(),
  kind: "group",
  label,
  order,
});

const ensureGroup = (
  parent: MutableGroup,
  dirSegment: string
): MutableGroup => {
  const existing = parent.index.get(dirSegment);
  if (existing) {
    return existing;
  }
  const groupName = dirSegment.match(GROUP_FOLDER)?.groups?.label;
  const label = humanize(groupName ?? dirSegment);
  const group = createGroup(label, numericOrder(dirSegment));
  parent.index.set(dirSegment, group);
  parent.children.push(group);
  return group;
};

const pageOrder = (page: PageRecord, filename: string): number => {
  if (page.meta.sidebar.order !== undefined) {
    return page.meta.sidebar.order;
  }
  // Index pages lead their group.
  if (filename.replace(extname(filename), "") === "index") {
    return Number.NEGATIVE_INFINITY;
  }
  return numericOrder(filename);
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

const toNavNode = (node: MutableNode): NavNode => {
  if (node.kind === "page") {
    return {
      badge: node.badge,
      icon: node.icon,
      kind: "page",
      label: node.label,
      pageId: node.pageId,
      route: node.route,
    };
  }
  return {
    children: node.children.map(toNavNode),
    collapsed: node.collapsed,
    icon: node.icon,
    kind: "group",
    label: node.label,
  };
};

/** Build the navigation tree from the file-system structure of pages. */
const buildNavigation = (pages: PageRecord[]): Navigation => {
  const root = createGroup("", 0);

  for (const page of pages) {
    if (page.meta.sidebar.hidden) {
      continue;
    }
    const parts = page.id.split("/");
    const filename = parts.at(-1) ?? page.id;
    const dirs = parts.slice(0, -1);

    let parent = root;
    for (const dir of dirs) {
      parent = ensureGroup(parent, dir);
    }

    parent.children.push({
      badge: page.meta.sidebar.badge,
      icon: page.meta.sidebar.icon,
      kind: "page",
      label: page.meta.sidebar.label ?? page.title,
      order: pageOrder(page, filename),
      pageId: page.id,
      route: page.route,
    });
  }

  sortNodes(root.children);

  return {
    sidebar: root.children.map(toNavNode),
    tabs: [],
  };
};

/** Assemble the content graph: routes map, nav, and duplicate diagnostics. */
export const buildContentGraph = (pages: PageRecord[]): ContentGraph => {
  const routes = new Map<string, string>();
  const diagnostics: Diagnostic[] = [];

  for (const page of pages) {
    const existing = routes.get(page.route);
    if (existing) {
      diagnostics.push({
        code: "BLUME_DUPLICATE_ROUTE",
        file: page.sourcePath,
        message: `Two files resolve to ${page.route}: ${existing} and ${page.id}`,
        severity: "error",
        suggestion: "Rename or move one of the files so each route is unique.",
      });
      continue;
    }
    routes.set(page.route, page.id);
  }

  return {
    diagnostics,
    navigation: buildNavigation(pages),
    pages,
    routes,
  };
};

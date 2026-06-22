import type { NavNode } from "../../core/types.ts";

/** A flat, ordered page reference used for previous/next pagination. */
export interface FlatPage {
  route: string;
  label: string;
}

/** A breadcrumb segment; `route` is absent for group ancestors. */
export interface Crumb {
  label: string;
  route?: string;
}

/** Flatten the sidebar tree into ordered internal page links. */
export const flattenPages = (nodes: NavNode[]): FlatPage[] => {
  const out: FlatPage[] = [];
  const walk = (items: NavNode[]): void => {
    for (const item of items) {
      if (item.kind === "group") {
        walk(item.children);
      } else if (item.pageId) {
        // Skip external links (no backing page).
        out.push({ label: item.label, route: item.route });
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
        const found = search(item.children, [...trail, { label: item.label }]);
        if (found) {
          return found;
        }
      }
    }
    return null;
  };
  return search(nodes, []) ?? [];
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

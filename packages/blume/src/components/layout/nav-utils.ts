import type { NavNode } from "../../core/types.ts";

/** A flat, ordered page reference used for previous/next pagination. */
export interface FlatPage {
  route: string;
  label: string;
  deprecated?: boolean;
}

export interface DirectoryListingItem {
  kind: "group" | "page";
  label: string;
  route?: string;
  description?: string;
  icon?: string;
  badge?: string;
  children: DirectoryListingItem[];
}

export interface DirectoryListing {
  label: string;
  mode: "accordion" | "card";
  items: DirectoryListingItem[];
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

const toDirectoryListingItems = (nodes: NavNode[]): DirectoryListingItem[] =>
  nodes.flatMap((item): DirectoryListingItem[] => {
    if (item.kind === "page") {
      return [
        {
          badge: item.badge,
          children: [],
          description: item.description,
          icon: item.icon,
          kind: "page",
          label: item.label,
          route: item.route,
        },
      ];
    }

    const children = toDirectoryListingItems(item.children);
    if (!item.route && children.length === 0) {
      return [];
    }

    return [
      {
        badge: item.badge,
        children,
        icon: item.icon,
        kind: "group",
        label: item.label,
        route: item.route,
      },
    ];
  });

/** Find the configured child directory listing for the current root page. */
export const findDirectoryListing = (
  nodes: NavNode[],
  route: string
): DirectoryListing | null => {
  const search = (items: NavNode[]): DirectoryListing | null => {
    for (const item of items) {
      if (item.kind !== "group") {
        continue;
      }
      if (item.route === route && item.directory && item.directory !== "none") {
        return {
          items: toDirectoryListingItems(item.children),
          label: item.label,
          mode: item.directory,
        };
      }
      const found = search(item.children);
      if (found) {
        return found;
      }
    }
    return null;
  };
  return search(nodes);
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

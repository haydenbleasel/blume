import { extname } from "pathe";

import { stripBasePath, withBasePath } from "./base-path.ts";
import { orderingPrefix, stripOrderingPrefix } from "./ordering-prefix.ts";
import type {
  FolderMeta,
  SidebarDisplay,
  SidebarItemConfig,
} from "./schema.ts";
import type {
  Diagnostic,
  FeaturedLink,
  HeaderAction,
  NavNode,
  Navigation,
  NavSelector,
  NavTab,
  PageRecord,
} from "./types.ts";

const GROUP_FOLDER = /^\((?<label>.+)\)$/u;
const WORD_SPLIT = /[-_]/u;

/**
 * Whether `route` is the section root `base` or nested beneath it. Requires a
 * path boundary, so `/api-reference` is not under `/api`. The root `/` spans
 * every route.
 */
export const isUnderPath = (route: string, base: string): boolean =>
  base === "/" || route === base || route.startsWith(`${base}/`);

/**
 * Whether `tab` is the root tab of the tree rooted at `root` — the tab that
 * spans the whole sidebar rather than one section. Tab paths and the root
 * normally share one path space, so the root tab sits at `root` exactly (`/`,
 * `/en`, `/docs`); in an archived version tree the root is versionized
 * (`/v1.0`, `/docs/v1.0`) while tab paths stay in current-docs space, so the
 * root tab is any tab the whole root sits under. The one definition shared by
 * sidebar scoping, tab-section hoisting, and the header's current-tab state —
 * consumers that disagree on which tab is the root tab prune an archived
 * sidebar or highlight the wrong tab over it.
 */
export const isRootTab = (tab: NavTab, root: string): boolean =>
  isUnderPath(root, tab.path);

/**
 * A page's sidebar icon: `sidebar.icon`, or the top-level `icon` shorthand
 * (the Mintlify-style spelling) when the nested key is unset.
 */
const sidebarIcon = (page: PageRecord): string | undefined =>
  page.meta.sidebar.icon ?? page.meta.icon;

/**
 * Words a folder name spells in lowercase that read wrong capitalized: the
 * acronyms and brand casings docs folders are named after (`api-reference`
 * is "API Reference", not "Api Reference").
 */
const WORD_FORMS = new Map([
  ["ai", "AI"],
  ["api", "API"],
  ["apis", "APIs"],
  ["asyncapi", "AsyncAPI"],
  ["cli", "CLI"],
  ["css", "CSS"],
  ["faq", "FAQ"],
  ["faqs", "FAQs"],
  ["graphql", "GraphQL"],
  ["html", "HTML"],
  ["http", "HTTP"],
  ["https", "HTTPS"],
  ["id", "ID"],
  ["ids", "IDs"],
  ["ios", "iOS"],
  ["js", "JS"],
  ["json", "JSON"],
  ["jwt", "JWT"],
  ["llm", "LLM"],
  ["llms", "LLMs"],
  ["macos", "macOS"],
  ["mcp", "MCP"],
  ["oauth", "OAuth"],
  ["openapi", "OpenAPI"],
  ["rss", "RSS"],
  ["sdk", "SDK"],
  ["sdks", "SDKs"],
  ["seo", "SEO"],
  ["sql", "SQL"],
  ["sso", "SSO"],
  ["ts", "TS"],
  ["ui", "UI"],
  ["url", "URL"],
  ["urls", "URLs"],
  ["xml", "XML"],
  ["yaml", "YAML"],
]);

/**
 * Capitalize one word of a slug-like name for display, spelling the acronyms
 * and brand casings in {@link WORD_FORMS} their own way (`api` → "API").
 * Shared with page titles derived from file names, so a page and a folder
 * named alike read alike.
 */
export const titleWord = (word: string): string =>
  WORD_FORMS.get(word) ?? word.charAt(0).toUpperCase() + word.slice(1);

const humanize = (segment: string): string =>
  stripOrderingPrefix(segment)
    .split(WORD_SPLIT)
    .filter(Boolean)
    .map(titleWord)
    .join(" ");

const numericOrder = (segment: string): number => {
  const value = orderingPrefix(segment);
  return value ? Math.trunc(Number(value)) : Number.POSITIVE_INFINITY;
};

/**
 * The name inside a group folder's parentheses — `(guides)`, or `01-(guides)`
 * with its ordering prefix outside them — else undefined. A prefix written
 * inside (`(01-guides)`) stays in the name, where it sorts and drops like any
 * folder's.
 */
const groupName = (raw: string): string | undefined =>
  (raw.match(GROUP_FOLDER) ?? stripOrderingPrefix(raw).match(GROUP_FOLDER))
    ?.groups?.label;

/**
 * A folder's sidebar order: its ordering prefix, or — for a group folder
 * without one outside the parentheses — the prefix inside them, so
 * `01-(guides)` and `(01-guides)` both sort like `01-guides`.
 */
const folderOrder = (raw: string): number =>
  numericOrder(
    orderingPrefix(raw) === undefined ? (groupName(raw) ?? raw) : raw
  );

/** The nav key of a raw path segment: group label or numeric-stripped name. */
const segmentKey = (raw: string): string =>
  stripOrderingPrefix(groupName(raw) ?? raw);

/**
 * Whether a filename stem is a directory index, ignoring an ordering prefix:
 * route mapping strips the prefix before dropping `index`, so `01-index` routes
 * exactly like `index` and must be treated as one here too.
 */
const isIndexStem = (stem: string): boolean =>
  stripOrderingPrefix(stem) === "index";

/** A filename's stem: the name with its extension stripped. */
const stemOf = (filename: string): string =>
  filename.replace(extname(filename), "");

/**
 * The stem of a nav path's last segment. The single index-detection input for
 * the warn path (`sidebarDisplayIgnoredDiagnostics`) and the apply path
 * (`buildFileSystemSidebar`), so the two can't drift apart on what counts as
 * a folder's index page.
 */
const navStem = (navPath: string): string =>
  stemOf(navPath.split("/").at(-1) ?? navPath);

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
  /** Whether `order` is the node's position in its folder meta `pages` list. */
  ranked?: boolean;
}

interface MutableGroup {
  kind: "group";
  key: string;
  path: string;
  /** The group's URL path (folder route prefix); set as pages are inserted. */
  routePath?: string;
  /**
   * The group's URL path read off its folder names, from a page whose
   * frontmatter `slug` moved it off the folder's path. Fills `routePath` only
   * when no other page under the folder supplies one.
   */
  folderPath?: string;
  /** The folder's index page route, when it has one; the group row's link. */
  route?: string;
  label: string;
  icon?: string;
  collapsed?: boolean;
  display?: SidebarDisplay;
  order: number;
  /** Whether `order` is the node's position in its folder meta `pages` list. */
  ranked?: boolean;
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
    humanize(groupName(rawSegment) ?? rawSegment),
    folderOrder(rawSegment)
  );
  parent.index.set(rawSegment, group);
  parent.children.push(group);
  return group;
};

interface PageOrder {
  order: number;
  /** Whether the order came from the author (frontmatter or a rank prefix). */
  orderIsAuthored: boolean;
}

const pageOrder = (page: PageRecord, filename: string): PageOrder => {
  if (page.meta.sidebar.order !== undefined) {
    return { order: page.meta.sidebar.order, orderIsAuthored: true };
  }
  if (isIndexStem(stemOf(filename))) {
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
  // (`20240105-release.md`) rather than a rank, so it is derived too. An ISO
  // date (`2024-01-05-release.md`) is no ordering prefix at all.
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

/**
 * What an i18n locale's tree mirrors from the fallback locale for a folder it
 * has no meta of its own for: the fallback locale's folder meta, and the
 * `sidebar.display` of a fallback-filled index page. Empty for the fallback
 * locale itself and for single-locale sites.
 */
interface FallbackFolderMeta {
  indexDisplay: Map<string, SidebarDisplay>;
  meta: (path: string) => FolderMeta | undefined;
}

/**
 * Apply folder meta (title/order/icon/collapsed/display and explicit page
 * order), plus the index-frontmatter display sugar collected per folder path.
 */
const applyFolderMeta = (
  group: MutableGroup,
  folderMeta: Map<string, FolderMeta>,
  sharedMeta: Map<string, FolderMeta>,
  metaPrefix: string,
  sharedMetaPrefix: string,
  indexDisplay: Map<string, SidebarDisplay>,
  indexRoute: Map<string, string>,
  fallback: FallbackFolderMeta
): void => {
  // A folder with an index page links its group row to it — the same shape
  // as an explicit-config group's `root`, and the only sidebar link to the
  // section's own page once the index row is hidden. Index-less folders keep
  // no link: their row would 404.
  group.route = indexRoute.get(group.path);
  group.routePath ??= group.folderPath;
  // Locale-specific meta wins; a shared `meta.$.*` (keyed by the locale-stripped
  // group path — version-prefixed inside a snapshot) applies to every locale
  // otherwise.
  const localeMeta =
    folderMeta.get(metaKey(group.path, metaPrefix)) ??
    sharedMeta.get(metaKey(group.path, sharedMetaPrefix));
  // A locale with neither mirrors the fallback locale's group, the way its
  // tree mirrors that locale's untranslated pages: the fallback's folder
  // meta, and — ahead of it, as in the fallback's own tree — the display its
  // fallback-filled index page sets. A locale's own meta owns its group, so
  // the fallback's index frontmatter never overrides it.
  const mirrored = localeMeta === undefined;
  const meta = localeMeta ?? fallback.meta(group.path);
  // The group's own render mode, resolved index frontmatter first, then folder
  // meta; `toNavNode` falls back to the global mode. Applies to this group
  // only — nested subgroups resolve their own value through the same chain.
  group.display =
    indexDisplay.get(group.path) ??
    (mirrored ? fallback.indexDisplay.get(group.path) : undefined) ??
    meta?.display;
  if (meta) {
    group.label = meta.title ?? group.label;
    group.icon = meta.icon ?? group.icon;
    group.order = meta.order ?? group.order;
    group.collapsed = meta.collapsed ?? group.collapsed;
  }

  for (const child of group.children) {
    if (child.kind === "group") {
      applyFolderMeta(
        child,
        folderMeta,
        sharedMeta,
        metaPrefix,
        sharedMetaPrefix,
        indexDisplay,
        indexRoute,
        fallback
      );
    }
  }

  // Ranked after the children resolved their own meta: the `pages` list is
  // this folder's word on its children's order, so it wins over a listed
  // subfolder's own `order` just as it wins over a listed page's
  // `sidebar.order`.
  if (meta?.pages) {
    const rank = new Map(meta.pages.map((key, i) => [key, i]));
    for (const child of group.children) {
      const position = rank.get(child.key);
      if (position !== undefined) {
        child.order = position;
        child.ranked = true;
        if (child.kind === "page") {
          child.orderIsAuthored = true;
        }
      }
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
 * Only fires when the index page's own sidebar row is hidden
 * (`sidebar.hidden`), so the linked group header is the only sidebar label the
 * page has. A visible index row shows the page's own label beneath the header,
 * so the sidebar already carries both titles and a divergence there is a
 * deliberate pairing ("CLI" over "Overview"), not drift.
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
  metaPrefix: string,
  sharedMetaPrefix: string
): Diagnostic | undefined => {
  if (
    !(page.meta.title && page.meta.sidebar.hidden) ||
    page.fallback ||
    folderPath === ""
  ) {
    return undefined;
  }
  const meta =
    folderMeta.get(metaKey(folderPath, metaPrefix)) ??
    sharedMeta.get(metaKey(folderPath, sharedMetaPrefix));
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

/**
 * Warn wherever a page's `sidebar.display` is dead weight, instead of
 * silently dropping it:
 *
 * - On any page under an explicit `navigation.sidebar` config: the config
 *   items own each group's display mode, and neither index frontmatter nor
 *   folder meta is read — index pages included.
 * - On the content root's own index page: the root is not a sidebar group,
 *   so there is nothing for the value to configure; the sidebar-wide mode
 *   lives in `navigation.sidebar.display`.
 * - On any other non-index page: only a folder's index page can configure
 *   its group's display mode.
 *
 * A non-root folder index under the generated sidebar is the one placement
 * that IS honored, so it alone is exempt. Under i18n fallback fill the same
 * source file is checked once per locale with an identical message, and the
 * graph-level code+file+message dedupe collapses the copies.
 */
const sidebarDisplayIgnoredDiagnostics = (
  pages: PageRecord[],
  explicitSidebar: boolean
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  for (const page of pages) {
    if (!page.meta.sidebar.display) {
      continue;
    }
    const isIndex = isIndexStem(navStem(page.navPath));
    if (explicitSidebar) {
      diagnostics.push({
        code: "BLUME_SIDEBAR_DISPLAY_IGNORED",
        file: page.sourcePath ?? page.id,
        message: `"${page.navPath}" sets sidebar.display, but the explicit navigation.sidebar config owns each group's display mode — the value is ignored.`,
        severity: "warning",
        suggestion:
          "Set display on the matching group in navigation.sidebar, or remove the frontmatter key.",
      });
      continue;
    }
    if (isIndex && !page.navPath.includes("/")) {
      diagnostics.push({
        code: "BLUME_SIDEBAR_DISPLAY_IGNORED",
        file: page.sourcePath ?? page.id,
        message: `"${page.navPath}" sets sidebar.display, but the content root is not a sidebar group — the value is ignored.`,
        severity: "warning",
        suggestion:
          "Set navigation.sidebar.display in blume.config to change the sidebar-wide mode.",
      });
      continue;
    }
    if (isIndex) {
      continue;
    }
    diagnostics.push({
      code: "BLUME_SIDEBAR_DISPLAY_IGNORED",
      file: page.sourcePath ?? page.id,
      message: `"${page.navPath}" sets sidebar.display, but only a folder's index page can set its group's display mode — the value is ignored.`,
      severity: "warning",
      suggestion:
        "Move display to the folder's index page frontmatter, or set it in the folder's meta.ts.",
    });
  }
  return diagnostics;
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
 *
 * A folder meta `pages` rank is a list position, not a number the author
 * picked, so it only ties with another rank: a listed page at position 1
 * beside an unlisted `01-setup.md` is not a conflict anyone wrote.
 */
const duplicateOrderDiagnostics = (nodes: MutableNode[]): Diagnostic[] => {
  const byOrder = new Map<string, { order: number; tied: MutableNode[] }>();
  for (const node of nodes) {
    if (!Number.isFinite(node.order) || !isAuthoredOrder(node)) {
      continue;
    }
    const key = `${node.ranked === true}:${node.order}`;
    const entry = byOrder.get(key);
    if (entry) {
      entry.tied.push(node);
    } else {
      byOrder.set(key, { order: node.order, tied: [node] });
    }
  }
  const diagnostics: Diagnostic[] = [];
  for (const { order, tied } of byOrder.values()) {
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
 * Hoist loose pages above groups so they read as their own level's entries
 * rather than a preceding group's trailing children (relative order otherwise
 * preserved). The root level always hoists, in every display mode. A deeper
 * level hoists only when a sibling group renders flat — a flat group is a
 * plain section header, so a loose page sorted after it would visually read
 * as its last child — while `group`/`page` groups are self-delimiting
 * disclosure/drill-in rows, so authored interleaving is kept. Each group's
 * render mode is its own resolved `display` falling back to the global mode,
 * mirroring `toNavNode`.
 */
const hoistPages = (
  nodes: MutableNode[],
  display: SidebarDisplay,
  hoist: boolean
): void => {
  const groups = nodes.filter((node) => node.kind === "group");
  if (hoist || groups.some((group) => (group.display ?? display) === "flat")) {
    const pages = nodes.filter((node) => node.kind === "page");
    nodes.splice(0, nodes.length, ...pages, ...groups);
  }
  for (const group of groups) {
    hoistPages(group.children, display, false);
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
  display: SidebarDisplay
): void => {
  for (const node of nodes) {
    if (node.kind !== "group") {
      continue;
    }
    if (node.routePath !== undefined && tabPaths.has(node.routePath)) {
      hoistPages(node.children, display, true);
    }
    hoistTabSections(node.children, tabPaths, display);
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
    display: node.display ?? display,
    icon: node.icon,
    kind: "group",
    label: node.label,
    path: node.routePath,
    route: node.route,
  };
};

/** Build the sidebar tree from the file system and folder meta. */
const buildFileSystemSidebar = (
  pages: PageRecord[],
  folderMeta: Map<string, FolderMeta>,
  sharedMeta: Map<string, FolderMeta>,
  metaPrefix: string,
  sharedMetaPrefix: string,
  display: SidebarDisplay,
  tabPaths: Set<string>,
  diagnostics: Diagnostic[] = [],
  fallbackMetaPrefix?: string
): NavNode[] => {
  const root = createGroup("", "", "", 0);
  // Folder path -> `sidebar.display` from that folder's index page frontmatter.
  // Collected before the hidden filter (like the title check): hiding the index
  // row from the panel shouldn't stop it configuring its group.
  const indexDisplay = new Map<string, SidebarDisplay>();
  // What a group with no meta of this locale's mirrors from the fallback
  // locale (see `applyFolderMeta`).
  const fallback: FallbackFolderMeta = {
    indexDisplay: new Map(),
    meta: (path) =>
      fallbackMetaPrefix === undefined
        ? undefined
        : folderMeta.get(metaKey(path, fallbackMetaPrefix)),
  };
  // Folder path -> that folder's index page route, for the group row's link.
  // Also collected before the hidden filter: hiding the index row is how a
  // site drops the duplicate label under a linked header, so the link must
  // survive it. The content root is not a group, so its index is skipped.
  const indexRoute = new Map<string, string>();

  for (const page of pages) {
    // Group by the locale-stripped path so the locale dir is not a nav group.
    const parts = page.navPath.split("/");
    const filename = parts.at(-1) ?? page.navPath;
    const stem = stemOf(filename);
    const dirs = parts.slice(0, -1);

    // Checked before the hidden filter: the title check fires only for a
    // sidebar-hidden index page, whose own <title> the header label stands in
    // for, so it must see the pages the filter drops.
    if (isIndexStem(stem)) {
      const diagnostic = indexTitleMismatchDiagnostic(
        page,
        dirs.join("/"),
        folderMeta,
        sharedMeta,
        metaPrefix,
        sharedMetaPrefix
      );
      if (diagnostic) {
        diagnostics.push(diagnostic);
      }
      // A fallback-filled index's display is kept apart (like the title check
      // above exempts it): its frontmatter belongs to the fallback locale, so
      // it only speaks for a group this locale has no meta for — letting it
      // override this locale's own authored `meta.ts` display would silently
      // flip again the day the index gets translated.
      if (page.meta.sidebar.display) {
        (page.fallback ? fallback.indexDisplay : indexDisplay).set(
          dirs.join("/"),
          page.meta.sidebar.display
        );
      }
      if (dirs.length > 0) {
        indexRoute.set(dirs.join("/"), page.route);
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
    const routeDirCount = dirs.filter(
      (dir) => groupName(dir) === undefined
    ).length;
    const offset = Math.max(0, folderParts.length - routeDirCount);
    // A frontmatter `slug` publishes the page away from its folder, so its
    // route says nothing about where the folder lives (`guides/a.md` with
    // `slug: install` is `/install`). Its groups read their path off the folder
    // names instead, behind the route's leading base/locale/version segments
    // (whatever precedes the slug's own `versionKey`), and only where no
    // other page under the folder supplies one.
    const slugged = page.meta.slug !== undefined;
    const leading = routeSegments.slice(
      0,
      Math.max(
        0,
        routeSegments.length - page.versionKey.split("/").filter(Boolean).length
      )
    );

    let parent = root;
    let consumed = offset;
    const folders: string[] = [];
    for (const dir of dirs) {
      parent = ensureGroup(parent, dir);
      if (groupName(dir) === undefined) {
        consumed += 1;
        folders.push(stripOrderingPrefix(dir));
      }
      if (slugged) {
        parent.folderPath ??= `/${[...leading, ...folders].join("/")}`;
      } else {
        parent.routePath ??= `/${folderParts.slice(0, consumed).join("/")}`;
      }
    }

    const { order, orderIsAuthored } = pageOrder(page, filename);
    parent.children.push({
      badge: page.meta.sidebar.badge,
      deprecated: page.meta.deprecated || undefined,
      description: page.description,
      file: page.sourcePath,
      icon: sidebarIcon(page),
      key: segmentKey(stem),
      kind: "page",
      label: page.meta.sidebar.label ?? page.title,
      order,
      orderIsAuthored,
      pageId: page.id,
      route: page.route,
    });
  }

  applyFolderMeta(
    root,
    folderMeta,
    sharedMeta,
    metaPrefix,
    sharedMetaPrefix,
    indexDisplay,
    indexRoute,
    fallback
  );
  sortNodes(root.children, diagnostics);
  hoistPages(root.children, display, true);
  hoistTabSections(root.children, tabPaths, display);
  return root.children.map((child) => toNavNode(child, display));
};

/**
 * An explicit-sidebar ref (`"guides/"`, `"/guides/index"`, `"index"`) in the
 * slashless route form pages are keyed by (`/guides`, `/`).
 */
export const normalizeRef = (ref: string): string => {
  if (ref === "index") {
    return "/";
  }
  const withSlash = ref.startsWith("/") ? ref : `/${ref}`;
  // Routes are stored slashless (`/guides`, not `/guides/`); a hand-written
  // `"guides/"` ref must still find its page instead of being silently
  // dropped from the sidebar.
  const noTrailing = withSlash.replace(/\/+$/u, "");
  const trimmed = noTrailing.endsWith("/index")
    ? noTrailing.slice(0, -"/index".length)
    : noTrailing;
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

/** An explicit-config sidebar item written as a bare page-ref string. */
export const isPageRef = (item: SidebarItemConfig): item is string =>
  typeof item === "string";

/**
 * Pages keyed the way explicit-sidebar refs look them up: by the
 * locale-agnostic `translationKey` under i18n (`byLogical`), so one authored
 * sidebar maps onto every locale's pages, else by route. Refs are authored as
 * if mounted at root while `page.route` carries the base, so each page is also
 * aliased under its base-less route (the `translationKey` is base-less
 * already).
 */
export const pagesByRef = (
  pages: PageRecord[],
  basePath: string,
  byLogical: boolean
): Map<string, PageRecord> => {
  const byRoute = new Map(
    pages.map((page) => [byLogical ? page.translationKey : page.route, page])
  );
  if (basePath && !byLogical) {
    for (const page of pages) {
      const bare = stripBasePath(basePath, page.route);
      if (!byRoute.has(bare)) {
        byRoute.set(bare, page);
      }
    }
  }
  return byRoute;
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
  if (isPageRef(item)) {
    const page = byRoute.get(normalizeRef(item));
    if (!page) {
      return null;
    }
    return {
      badge: page.meta.sidebar.badge,
      deprecated: page.meta.deprecated || undefined,
      description: page.description,
      icon: sidebarIcon(page),
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
    if (!isPageRef(item) && item.items) {
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
 * The two roots a tab's target resolves between, both based: `tabs`, the root
 * of the space tab paths are written in (the current docs' localized root,
 * `/fr`), and `tree`, the root this tree's pages live under — the same route,
 * except in an archived version tree (`/fr/v1.0`).
 */
interface TabRoots {
  tabs: string;
  tree: string;
}

/**
 * `path` relative to `root` (`/fr/guides` under `/fr` is `/guides`, the root
 * itself is `/`), or undefined when it isn't under it.
 */
const pathUnder = (path: string, root: string): string | undefined => {
  if (root === "/") {
    return path;
  }
  if (path === root) {
    return "/";
  }
  return path.startsWith(`${root}/`) ? path.slice(root.length) : undefined;
};

/** Mount a root-relative remainder (`/guides`, never `/`) under `root`. */
const joinRoute = (root: string, rest: string): string =>
  root === "/" ? rest : `${root}${rest}`;

/**
 * Resolve a tab's clickable target. A tab's `path` scopes its sidebar section
 * but need not be a real route — a section with no index page would 404 if the
 * tab linked straight to it. Prefer the path itself when it's served outside
 * the content tree (the generated changelog index) or is a page/group in the
 * tree; otherwise fall back to the first linkable route in the section
 * (sidebar order).
 *
 * Routes outside the content tree are served at their own path, not under
 * `basePath` (`pages/changelog.astro` answers `/changelog` on a `/docs`-based
 * site) or a locale prefix, while tab paths arrive based and localized
 * (`/docs/fr/changelog`). So when the tab path is neither an outside route nor
 * a tree node, its base-less and then its root-relative form (`/changelog`)
 * are checked against the outside routes before the section's first page
 * wins.
 *
 * In an archived version tree the section is looked up under the versioned
 * root (`/v1.0/guides`), where that tree's pages live — tab paths stay in
 * current-docs space, where nothing in the tree could match.
 */
const resolveTabHref = (
  sidebar: NavNode[],
  path: string,
  extraRoutes: ReadonlySet<string>,
  basePath: string,
  roots: TabRoots
): string => {
  if (extraRoutes.has(path)) {
    return path;
  }
  const rest = pathUnder(path, roots.tabs);
  const section =
    rest === undefined || rest === "/" ? path : joinRoute(roots.tree, rest);
  let first: string | undefined;
  const walk = (nodes: NavNode[]): boolean => {
    for (const node of nodes) {
      const { route } = node;
      if (route === section) {
        return true;
      }
      if (
        first === undefined &&
        route !== undefined &&
        route.startsWith(`${section}/`)
      ) {
        first = route;
      }
      if (node.kind === "group" && walk(node.children)) {
        return true;
      }
    }
    return false;
  };
  if (walk(sidebar)) {
    return section;
  }
  const bare = stripBasePath(basePath, path);
  if (extraRoutes.has(bare)) {
    return bare;
  }
  if (rest !== undefined && extraRoutes.has(rest)) {
    return rest;
  }
  return first ?? path;
};

/**
 * Attach a resolved `href` to each tab whose section has no index page. An
 * author-declared `href` is the tab's stated target, so it's kept as-is —
 * resolution only fills in the tabs that didn't declare one. That's what lets a
 * tab point at a route outside the content tree that resolution can't see (a
 * custom `.astro` page); the generated changelog index arrives in
 * `extraRoutes`, so a `/changelog` tab needs no `href`.
 */
const withTabHrefs = (
  tabs: NavTab[],
  sidebar: NavNode[],
  extraRoutes: ReadonlySet<string>,
  basePath: string,
  roots: TabRoots
): NavTab[] =>
  tabs.map((tab) => {
    const href =
      tab.href ??
      resolveTabHref(sidebar, tab.path, extraRoutes, basePath, roots);
    return href === tab.path ? tab : { ...tab, href };
  });

/**
 * Rebase config-provided nav chrome (featured links, selectors, tabs) under the
 * site base path. Config paths are authored as if mounted at root, so the base
 * is applied here (idempotently, and only to internal paths — external URLs
 * pass through). With no base this is a pure pass-through — the arrays keep
 * their exact authored shape.
 */
interface NavChrome {
  actions: HeaderAction[];
  cta: HeaderAction | null;
  featured: FeaturedLink[];
  selectors: NavSelector[];
  tabs: NavTab[];
}

const rebaseNavChrome = (
  basePath: string,
  options: {
    actions?: HeaderAction[];
    cta?: HeaderAction | null;
    featured?: FeaturedLink[];
    selectors?: NavSelector[];
    tabs?: NavTab[];
  }
): NavChrome => {
  const actions = options.actions ?? [];
  const cta = options.cta ?? null;
  const featured = options.featured ?? [];
  const selectors = options.selectors ?? [];
  const tabs = options.tabs ?? [];
  if (!basePath) {
    return { actions, cta, featured, selectors, tabs };
  }
  const rebaseHref = <T extends { href: string }>(item: T): T => ({
    ...item,
    href: withBasePath(basePath, item.href),
  });
  const rebasePath = <T extends { path: string }>(item: T): T => ({
    ...item,
    path: withBasePath(basePath, item.path),
  });
  return {
    actions: actions.map(rebaseHref),
    cta: cta ? rebaseHref(cta) : null,
    featured: featured.map(rebaseHref),
    selectors: selectors.map((selector) => ({
      ...selector,
      items: selector.items.map(rebasePath),
    })),
    tabs: tabs.map((tab) => {
      const rebased: NavTab = {
        ...tab,
        items: tab.items?.map(rebasePath),
        path: withBasePath(basePath, tab.path),
      };
      if (tab.href) {
        rebased.href = withBasePath(basePath, tab.href);
      }
      return rebased;
    }),
  };
};

/** Build the complete navigation model from pages, meta, and config. */
export const buildNavigation = (
  pages: PageRecord[],
  options: {
    /** Plain links in the header, left of the icon buttons. */
    actions?: HeaderAction[];
    /** Site-wide route mount point (`""` or `/seg`); applied to config paths. */
    basePath?: string;
    /** The single primary call to action in the header. */
    cta?: HeaderAction | null;
    folderMeta: Map<string, FolderMeta>;
    /** Global display mode for every sidebar group (default `flat`). */
    display?: SidebarDisplay;
    featured?: FeaturedLink[];
    selectors?: NavSelector[];
    tabs?: NavTab[];
    sidebar?: SidebarItemConfig[];
    /**
     * Folder-meta lookup prefix (`""` for the default locale of the current
     * version): the version dir and/or locale dir hoisted in front of the
     * group path, e.g. `fr`, `v1.0`, or `v1.0/fr`.
     */
    metaPrefix?: string;
    /**
     * Folder-meta lookup prefix of the i18n fallback locale, whose untranslated
     * pages pad this tree (`""` for the default locale of the current
     * version). A group with no meta of this locale's mirrors the fallback
     * locale's. Unset for the fallback locale itself, and without i18n.
     */
    fallbackMetaPrefix?: string;
    /**
     * Prefix for shared `meta.$.*` lookups — the version dir inside a
     * snapshot (`v1.0`), since shared meta is locale-agnostic but still
     * version-specific. `""` for the current version.
     */
    sharedMetaPrefix?: string;
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
     * The root of the space tab paths are written in, before `basePath`: the
     * current docs' localized root (`"/"`, `/fr`). Defaults to
     * `localizedRoot`; an archived version tree passes it because its own
     * root is versionized (`/fr/v1.0`) while tab paths are not, so a tab's
     * section can be found under the version.
     */
    tabRoot?: string;
    /**
     * Sink for diagnostics produced while building the tree (duplicate sidebar
     * `order` values, index-page title/folder-meta-title mismatches). Pushed
     * into in place; omit to discard.
     */
    diagnostics?: Diagnostic[];
    /**
     * Routes served outside the content tree that a tab `path` may name
     * directly (the generated changelog index), so the tab links there instead
     * of falling back to its section's first page.
     */
    extraRoutes?: ReadonlySet<string>;
  }
): Navigation => {
  const basePath = options.basePath ?? "";
  const display = options.display ?? "flat";
  const metaPrefix = options.metaPrefix ?? "";
  const sharedMetaPrefix = options.sharedMetaPrefix ?? "";
  const sharedFolderMeta = options.sharedFolderMeta ?? new Map();
  const extraRoutes = options.extraRoutes ?? new Set<string>();

  // Content-derived sidebar routes are already based via `page.route`; the
  // based tab paths also feed tab-scoping below, so they must agree with the
  // based content routes.
  const { actions, cta, featured, selectors, tabs } = rebaseNavChrome(
    basePath,
    options
  );
  const byRoute = pagesByRef(pages, basePath, Boolean(options.refByLogical));

  // A tab pointing at the tree root spans the whole sidebar rather than one
  // section, so it must not feed tab-section hoisting. `tabs` carries final
  // paths (localized, then based), so the root is compared in the same space —
  // a root-level `(group)` folder's routePath is exactly the based/localized
  // prefix (`/docs`, `/fr`) and a bare `"/"` check would miss the match (or,
  // under a base, falsely scope a group named like the prefix). Carried on the
  // returned navigation so render-time scoping compares in the same space too.
  // In a version snapshot the root arrives versionized (`/v1.0`) while tab
  // paths stay in current-docs space, so root-tab checks use `isRootTab`
  // containment, not equality.
  const rootTabPath = withBasePath(basePath, options.localizedRoot ?? "/");
  const tabRoots: TabRoots = {
    tabs: withBasePath(
      basePath,
      options.tabRoot ?? options.localizedRoot ?? "/"
    ),
    tree: rootTabPath,
  };

  // Emitted here, before the sidebar-mode branch: an explicit config sidebar
  // ignores a stray `sidebar.display` just like the filesystem sidebar does
  // (and ignores it on index pages too), so both paths must warn.
  const diagnostics = options.diagnostics ?? [];
  diagnostics.push(
    ...sidebarDisplayIgnoredDiagnostics(pages, Boolean(options.sidebar))
  );

  if (options.sidebar) {
    const sidebar = buildConfigSidebar(
      options.sidebar,
      byRoute,
      display,
      basePath
    );
    return {
      actions,
      cta,
      featured,
      root: rootTabPath,
      selectors,
      sidebar,
      tabs: withTabHrefs(tabs, sidebar, extraRoutes, basePath, tabRoots),
    };
  }

  const sidebar = buildFileSystemSidebar(
    pages,
    options.folderMeta,
    sharedFolderMeta,
    metaPrefix,
    sharedMetaPrefix,
    display,
    new Set(
      tabs.flatMap((tab) => (isRootTab(tab, rootTabPath) ? [] : [tab.path]))
    ),
    diagnostics,
    options.fallbackMetaPrefix
  );
  return {
    actions,
    cta,
    featured,
    root: rootTabPath,
    selectors,
    sidebar,
    tabs: withTabHrefs(tabs, sidebar, extraRoutes, basePath, tabRoots),
  };
};

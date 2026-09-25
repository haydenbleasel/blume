import { fileURLToPath } from "node:url";

import { dirname, normalize, relative, resolve } from "pathe";

import { mountBasePath } from "../core/base-path.ts";
import { isIndexFileName, resolveRelativeHref } from "../core/links.ts";
import type { RelativeLinkBase } from "../core/links.ts";
import type { MdastNode, MdastValue } from "./mdast.ts";
import { routeSnapshotReader } from "./route-snapshot.ts";

interface UrlNode extends MdastNode {
  url?: string | null;
}

/** An MDX JSX attribute, as the plugin reads it. */
interface JsxAttribute {
  [key: string]: MdastValue;
  name?: string;
  type?: string;
  value?: MdastValue;
}

/** An MDX JSX element (`<Card href="./install" />`), as the plugin reads it. */
interface JsxNode extends MdastNode {
  attributes?: JsxAttribute[];
  children?: MdastValue[];
  name?: string | null;
}

/** The visitor-context slice this plugin uses (see `mdast.ts` for the model). */
interface RelativeLinksContext {
  fileURL: URL | undefined;
  replaceNode: (node: MdastNode, replacement: MdastNode) => void;
  setProperty: (node: MdastNode, key: "url", value: string) => void;
}

/** The slice of the `blume:data` snapshot the plugin reads. */
interface RouteData {
  config: {
    i18n?: { defaultLocale: string; locales: { code: string }[] } | null;
  };
  routes: {
    collection: string;
    entryId: string;
    fallback: boolean;
    locale: string;
    path: string;
  }[];
}

/** What the plugin knows about where content files publish. */
interface RouteIndex {
  /** `collection` + NUL + `entryId` → the route that entry publishes at. */
  routes: Map<string, string>;
  /** Every route the site serves, fallback copies included. */
  paths: Set<string>;
  /** Tokens an index file name may carry before its extension. */
  localeTokens: string[];
  /** The locale folders beside the default tree (every locale but the default). */
  localeFolders: string[];
}

/** A content file, located: its page, and how to find the files beside it. */
interface LocatedPage extends RelativeLinkBase {
  /** The route a sibling file publishes at, from its path relative to `file`. */
  routeOf: (path: string) => string | undefined;
  /** Every route the site serves, for dotted page names (`./node.js`). */
  routes: ReadonlySet<string>;
}

/** A JSX component name (`Card`, `Tree.File`), as opposed to an HTML tag. */
const COMPONENT_NAME = /^[A-Z]/u;

/** A plain string attribute value; an expression value isn't a link target. */
const isStringValue = (value: MdastValue): value is string =>
  typeof value === "string";

const entryKey = (collection: string, entryId: string): string =>
  `${collection}\0${entryId}`;

/**
 * Index the snapshot's routes by collection entry. A file shared by every
 * locale publishes once per locale; the default locale's route stands for it,
 * and the rendered link moves into the reader's locale afterwards (see
 * `LocaleLinks.astro`). Fallback copies render another locale's file, so they
 * never stand for it.
 */
const indexRoutes = (data: RouteData): RouteIndex => {
  const defaultLocale = data.config.i18n?.defaultLocale;
  const routes = new Map<string, string>();
  for (const route of data.routes) {
    if (route.fallback) {
      continue;
    }
    const key = entryKey(route.collection, route.entryId);
    if (!routes.has(key) || route.locale === defaultLocale) {
      routes.set(key, route.path);
    }
  }
  const locales = data.config.i18n?.locales.map((locale) => locale.code) ?? [];
  return {
    localeFolders: locales.filter((code) => code !== defaultLocale),
    localeTokens: data.config.i18n ? ["$", ...locales] : [],
    paths: new Set(data.routes.map((route) => route.path)),
    routes,
  };
};

/**
 * The same entry path in the default tree: a page in a locale folder that
 * links a sibling not translated yet (`fr/guides/setup.mdx` missing) means
 * the default tree's file (`guides/setup.mdx`), whose route — its own `slug`
 * included — moves into the reader's locale afterwards, onto the fallback
 * copy (see `LocaleLinks.astro`).
 */
const defaultTreePath = (
  entryId: string,
  localeFolders: readonly string[]
): string | undefined => {
  const slash = entryId.indexOf("/");
  return slash !== -1 && localeFolders.includes(entryId.slice(0, slash))
    ? entryId.slice(slash + 1)
    : undefined;
};

export interface RelativeLinksPluginOptions {
  /** The `docs` collection's base directory, which entry ids are relative to. */
  contentRoot?: string;
  /**
   * The `blume:data` JSON file, for an ejected app: with no CLI in the process
   * to publish the snapshot, the plugin reads the file eject writes instead.
   */
  dataFile?: string;
  /** Astro's `deployment.base` subdirectory (`""` or `/seg`). */
  deployBase?: string;
}

/**
 * Satteri MDAST plugin that rewrites relative page links (`[Install](./install)`,
 * `[Setup](../guides/setup.md)`) to the root-relative route they mean, using
 * the same file-style reading `blume validate` checks them against
 * (`resolveRelativeHref`). Left as written, the browser resolves them against
 * the page's slashless URL — so `./install` on an index page (`/guides`) lands
 * on `/install`, and a `.md` link opens the raw Markdown source instead of the
 * page. The page's own route, and a linked file's, come from the `blume:data`
 * snapshot the CLI publishes (or, ejected, the file eject writes), keyed by
 * collection entry: `docs` entries by their path under `contentRoot`, staged
 * entries (remote sources) by the longest trailing path that names one. A file
 * the snapshot doesn't know keeps its links as written.
 *
 * A rewritten route already carries `basePath`, and the `deployment.base`
 * prefix goes on here, unconditionally: the route is one Blume serves, so
 * `guides/setup.md` under base `/guides` is linked at `/guides/guides/setup`.
 * The base-links plugin that runs next is idempotent per layer, so it leaves
 * the based route alone.
 */
export const relativeLinksPlugin = (
  options: RelativeLinksPluginOptions = {}
) => {
  const contentRoot = options.contentRoot
    ? resolve(options.contentRoot)
    : undefined;
  const deployBase = options.deployBase ?? "";
  const readSnapshot = routeSnapshotReader(options.dataFile);

  // Parsed once per published snapshot: the CLI republishes on regeneration,
  // and an unchanged snapshot is the same string, so every page compiled
  // between regenerations reuses one index.
  let cached: { index: RouteIndex; text: string } | undefined;

  const routeIndex = (): RouteIndex | undefined => {
    const text = readSnapshot();
    if (text === undefined) {
      return undefined;
    }
    if (cached?.text !== text) {
      const data: RouteData = JSON.parse(text);
      cached = { index: indexRoutes(data), text };
    }
    return cached.index;
  };

  /** The page `file` renders, with a resolver for the files beside it. */
  const locate = (file: string, index: RouteIndex): LocatedPage | undefined => {
    const locateIn = (
      collection: string,
      base: string
    ): LocatedPage | undefined => {
      const entryId = relative(base, file);
      const route = index.routes.get(entryKey(collection, entryId));
      if (route === undefined) {
        return undefined;
      }
      return {
        isIndex: isIndexFileName(entryId, index.localeTokens),
        route,
        routeOf: (path) => {
          const target = relative(base, resolve(dirname(file), path));
          const inDefaultTree = defaultTreePath(target, index.localeFolders);
          return (
            index.routes.get(entryKey(collection, target)) ??
            (inDefaultTree === undefined
              ? undefined
              : index.routes.get(entryKey(collection, inDefaultTree)))
          );
        },
        routes: index.paths,
      };
    };
    if (contentRoot && !relative(contentRoot, file).startsWith("../")) {
      return locateIn("docs", contentRoot);
    }
    // A staged entry's id is its path under the staging dir, which the plugin
    // isn't told: the longest trailing path naming a staged entry wins.
    const segments = file.split("/");
    for (let start = 1; start < segments.length; start += 1) {
      const staged = locateIn(
        "staged",
        segments.slice(0, start).join("/") || "/"
      );
      if (staged) {
        return staged;
      }
    }
    return undefined;
  };

  /** The route `url` means on the page at `fileURL`, when it's relative. */
  const resolveUrl = (
    url: string,
    fileURL: URL | undefined
  ): string | undefined => {
    // Cheap first: a target that can't be relative never needs the index. A
    // dotted name (`./node.js`) passes, since only the index knows its route.
    if (
      !fileURL ||
      resolveRelativeHref(
        url,
        { isIndex: false, route: "/" },
        undefined,
        () => true
      ) === undefined
    ) {
      return undefined;
    }
    const index = routeIndex();
    const page = index && locate(normalize(fileURLToPath(fileURL)), index);
    if (!page) {
      return undefined;
    }
    const next = resolveRelativeHref(url, page, page.routeOf, (route) =>
      page.routes.has(route)
    );
    return next === undefined || next === url
      ? undefined
      : mountBasePath(deployBase, next);
  };

  const rewrite = (node: UrlNode, ctx: RelativeLinksContext): void => {
    const { url } = node;
    const next = isStringValue(url) ? resolveUrl(url, ctx.fileURL) : undefined;
    if (next !== undefined) {
      ctx.setProperty(node, "url", next);
    }
  };

  // A component's string `href` (`<Card href="./install">`) is the same kind
  // of link, and `blume validate` reads it as one. Lowercase elements are
  // raw HTML in a `.md` page, which neither rewrites nor checks, so only
  // components are rewritten; an expression-valued `href={…}` is left alone.
  const rewriteHref = (node: JsxNode, ctx: RelativeLinksContext): void => {
    if (!node.name || !COMPONENT_NAME.test(node.name)) {
      return;
    }
    const attributes = node.attributes ?? [];
    const at = attributes.findIndex(
      (attribute) =>
        attribute.type === "mdxJsxAttribute" &&
        attribute.name === "href" &&
        isStringValue(attribute.value)
    );
    const value = attributes[at]?.value;
    const next = isStringValue(value)
      ? resolveUrl(value, ctx.fileURL)
      : undefined;
    if (next !== undefined) {
      // Sätteri can't set a JSX element's attributes in place, so the element
      // is swapped for a copy; its children carry over and are still visited.
      ctx.replaceNode(node, {
        attributes: attributes.map((attribute, position) =>
          position === at
            ? { name: attribute.name, type: attribute.type, value: next }
            : attribute
        ),
        children: node.children ?? [],
        name: node.name,
        type: node.type,
      });
    }
  };

  // `link` covers inline links; `definition` covers reference-style
  // definitions (`[x]: ./install`). Images stay with the image pipeline, which
  // resolves relative embeds from beside the page source.
  return {
    definition: rewrite,
    link: rewrite,
    mdxJsxFlowElement: rewriteHref,
    mdxJsxTextElement: rewriteHref,
    name: "blume-relative-links",
  };
};

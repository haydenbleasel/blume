/**
 * Custom `.astro` pages on the agent surfaces. A content page has a Markdown
 * source the build serves as its mirror, lists in `llms.txt`, and dates in the
 * sitemap; a custom page has only the HTML it renders, which exists once Astro
 * has written it. So at the end of the build Blume reads each custom page back
 * and takes from it what those surfaces need: the page's `<main
 * id="blume-content">` (what `PageLayout` renders the page's own content into)
 * converted to Markdown, its title and meta description, whether it is
 * `noindex`, and the date it was last changed.
 *
 * What stays out of the Markdown is what an agent reading the page as text
 * can't use, or shouldn't see: scripts, styles, inline SVG, form controls,
 * navigation, decorative images (an empty `alt`), anything hidden from readers
 * (`hidden`, `aria-hidden="true"`, `inert`), and anything marked web-only — `data-blume-visibility="web"`, the
 * attribute `<Visibility for="web">` renders. The same attribute set to
 * `"agents"` keeps an element even when it is hidden on the page, so a custom
 * page can carry agents-only text the way a content page does. A `<main>`
 * that is itself web-only (PageLayout's `ai={{ exclude: true }}`) keeps the
 * whole page off the agent surfaces.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import type { Element, ElementContent, Nodes, Root, RootContent } from "hast";
import { fromHtml } from "hast-util-from-html";
import { toMdast } from "hast-util-to-mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { join } from "pathe";
import { z } from "zod";

import { hasGeneratedChangelog } from "../astro/pages.ts";
import { ERROR_ROUTES } from "../audit/types.ts";
import { mountBasePath, normalizeBasePath } from "../core/base-path.ts";
import { CHANGELOG_INDEX_ROUTE } from "../core/changelog-index.ts";
import {
  customStaticRoutes,
  discoverPages,
  discoverPagesSync,
} from "../core/custom-pages.ts";
import type { BlumeProject } from "../core/project-graph.ts";

/** The agent-facing view of a custom page. */
export interface BuiltPageDocument {
  /** The page's main content as Markdown. */
  markdown: string;
  /** The meta description, when the page has one. */
  description?: string;
  /** The page title, without a trailing site-name segment (see {@link pageTitle}). */
  title: string;
}

/** What the build reads back from one rendered page. */
export interface BuiltPage {
  route: string;
  /** Whether the page's robots meta says `noindex`. */
  noindex: boolean;
  /** When the page last changed (ISO 8601), from its JSON-LD or meta tags. */
  lastModified?: string;
  /**
   * The page as Markdown, when it joins the agent surfaces: it renders
   * Blume's content landmark, isn't `noindex`, and isn't web-only.
   */
  document?: BuiltPageDocument;
}

/** A built page that joins the agent surfaces. */
export interface BuiltAgentPage extends BuiltPage {
  document: BuiltPageDocument;
}

/** Elements whose content is never prose: dropped with everything inside. */
const DROPPED_TAGS = new Set([
  "button",
  "canvas",
  "dialog",
  "embed",
  "form",
  "iframe",
  "input",
  "nav",
  "noscript",
  "object",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
]);

/** The attribute `<Visibility>` renders, as hast names it. */
const VISIBILITY = "dataBlumeVisibility";

/** A heading's own anchor link, unwrapped to its text. */
const HEADING_ANCHOR = "blume-heading-anchor";

/** Separators a page title puts before a trailing site-name segment. */
const TITLE_SEPARATORS = [" — ", " – ", " - ", " | ", " · ", ": "];

const classNames = (node: Element): string[] => {
  const value = node.properties.className;
  return Array.isArray(value) ? value.map(String) : [];
};

const attribute = (node: Element, name: string): string | undefined => {
  const value = node.properties[name];
  if (value === undefined || value === null || value === false) {
    return;
  }
  return Array.isArray(value) ? value.join(" ") : String(value);
};

/**
 * Whether an element is kept out of the Markdown. An element marked for
 * agents stays even when it is hidden on the page.
 */
const isDropped = (node: Element): boolean => {
  const visibility = attribute(node, VISIBILITY);
  if (visibility === "agents") {
    return false;
  }
  return (
    visibility !== undefined ||
    DROPPED_TAGS.has(node.tagName) ||
    (node.tagName === "img" && !attribute(node, "alt")) ||
    node.properties.hidden === true ||
    node.properties.inert === true ||
    attribute(node, "ariaHidden") === "true"
  );
};

/** Elements whose text is literal: their whitespace is never touched. */
const LITERAL_TAGS = new Set(["code", "pre"]);

/** Text that opens with whitespace or closing punctuation needs no space before it. */
const OPENS_TIGHT = /^[\s.,;:!?)\]}’”'"]/u;

/** Text that closes with whitespace needs no space after it. */
const CLOSES_SPACED = /\s$/u;

/** What a node reads as once converted: its text, a line break, an image's alt. */
const renderedText = (node: ElementContent): string => {
  if (node.type !== "element") {
    return node.type === "text" ? node.value : "";
  }
  if (node.tagName === "br") {
    return "\n";
  }
  if (node.tagName === "img") {
    return attribute(node, "alt") ?? "";
  }
  return node.children.map(renderedText).join("");
};

/**
 * Whether two neighboring elements would read as one word. Astro's
 * `compressHTML` drops the whitespace between tags, so siblings only CSS
 * keeps apart (a flex row of spans, a card's title and description inside
 * one link) come out glued: "Claude Code by AnthropicChecked against". Both
 * must read as text, the left one not already ending in whitespace and the
 * right one not starting with whitespace or closing punctuation.
 */
const readsGlued = (left: ElementContent, right: ElementContent): boolean => {
  if (left.type !== "element" || right.type !== "element") {
    return false;
  }
  const before = renderedText(left);
  const after = renderedText(right);
  return (
    before !== "" &&
    after !== "" &&
    !CLOSES_SPACED.test(before) &&
    !OPENS_TIGHT.test(after)
  );
};

/**
 * One space between each pair of neighboring elements that would read as one
 * word (see {@link readsGlued}). An element with no text between them (an
 * icon's empty wrapper) doesn't keep them apart, but any text does: text
 * beside an element is prose, whose spacing the author wrote.
 */
const spaceGluedSiblings = (nodes: ElementContent[]): ElementContent[] => {
  const spaced: ElementContent[] = [];
  let previous: ElementContent | undefined;
  for (const node of nodes) {
    if (previous && readsGlued(previous, node)) {
      spaced.push({ type: "text", value: " " });
    }
    spaced.push(node);
    if (node.type === "text" || renderedText(node) !== "") {
      previous = node;
    }
  }
  return spaced;
};

/**
 * The element's children with the dropped ones removed, heading anchors
 * unwrapped, each code block's language moved onto its `<code>`, where the
 * converter reads it (Blume's code blocks carry it as `data-language` on the
 * `<pre>`), and glued siblings spaced apart — except inside `pre` and `code`
 * (`literal`), whose text is kept exactly.
 */
const cleanChildren = (
  children: ElementContent[],
  literal = false
): ElementContent[] => {
  const cleaned = children.flatMap((child): ElementContent[] => {
    if (child.type !== "element") {
      return child.type === "comment" ? [] : [child];
    }
    if (isDropped(child)) {
      return [];
    }
    const inner = cleanChildren(
      child.children,
      literal || LITERAL_TAGS.has(child.tagName)
    );
    if (child.tagName === "a" && classNames(child).includes(HEADING_ANCHOR)) {
      return inner;
    }
    const language = attribute(child, "dataLanguage");
    if (child.tagName === "pre" && language) {
      return [
        {
          ...child,
          children: inner.map((code) =>
            code.type === "element" && code.tagName === "code"
              ? {
                  ...code,
                  properties: {
                    ...code.properties,
                    className: [...classNames(code), `language-${language}`],
                  },
                }
              : code
          ),
        },
      ];
    }
    return [{ ...child, children: inner }];
  });
  return literal ? cleaned : spaceGluedSiblings(cleaned);
};

/** Every element in a tree, depth-first, in document order. */
const elements = (node: Nodes): Element[] => {
  const found: Element[] = [];
  const walk = (current: Nodes | RootContent): void => {
    if (current.type === "element") {
      found.push(current);
    }
    if ("children" in current) {
      for (const child of current.children) {
        walk(child);
      }
    }
  };
  walk(node);
  return found;
};

/** The text of an element's text-node children. */
const textOf = (node: Element): string =>
  node.children
    .map((child) => (child.type === "text" ? child.value : ""))
    .join("");

/** A `<meta>`'s content by its `name` or `property`. */
const metaContent = (all: Element[], key: string): string | undefined =>
  all
    .find(
      (node) =>
        node.tagName === "meta" &&
        (attribute(node, "name") === key || attribute(node, "property") === key)
    )
    ?.properties.content?.toString();

/** A URL or path reduced to its pathname without a trailing slash. */
const pathOf = (value: string): string => {
  const { pathname } = new URL(value, "https://blume.invalid");
  return pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
};

/**
 * The fields Blume reads from a JSON-LD node; anything else is ignored. A
 * node with one of them in another shape is skipped. `mainEntityOfPage` may
 * name the page by URL or as a node with an `@id`.
 */
const jsonLdNodeSchema = z.object({
  dateModified: z.string().optional(),
  mainEntityOfPage: z
    .union([
      z.string(),
      z.object({ "@id": z.string() }).transform((entity) => entity["@id"]),
    ])
    .optional(),
  url: z.string().optional(),
});

type JsonLdNode = z.infer<typeof jsonLdNodeSchema>;

/** A JSON-LD script's candidate nodes: its `@graph`, its array, or itself. */
const jsonLdScriptSchema = z.union([
  z
    .object({ "@graph": z.array(z.unknown()) })
    .transform((script) => script["@graph"]),
  z.array(z.unknown()),
  z.unknown().transform((node) => [node]),
]);

/** The JSON-LD nodes on the page, from every script that parses. */
const jsonLdNodes = (all: Element[]): JsonLdNode[] =>
  all.flatMap((node) => {
    if (
      node.tagName !== "script" ||
      attribute(node, "type") !== "application/ld+json"
    ) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(textOf(node));
    } catch {
      return [];
    }
    return jsonLdScriptSchema
      .parse(parsed)
      .flatMap((item) => jsonLdNodeSchema.safeParse(item).data ?? []);
  });

/** A date as ISO 8601, or undefined when it isn't one. */
const isoDate = (value: string | undefined): string | undefined => {
  if (!value) {
    return;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

/**
 * When the page last changed: `dateModified` on the JSON-LD node that
 * describes this page (its `url`, or `mainEntityOfPage`, is the page), else
 * the page's `article:modified_time`.
 */
const lastModifiedOf = (all: Element[], path: string): string | undefined => {
  const target = pathOf(path);
  const describes = (node: JsonLdNode): boolean =>
    [node.url, node.mainEntityOfPage].some(
      (value) => value !== undefined && pathOf(value) === target
    );
  for (const node of jsonLdNodes(all)) {
    const modified = describes(node) ? isoDate(node.dateModified) : undefined;
    if (modified) {
      return modified;
    }
  }
  return isoDate(metaContent(all, "article:modified_time"));
};

/**
 * The page's title for an index line: its `<title>`, less a trailing segment
 * naming the site ("Ultracite for Oxlint — Strict config" stays whole; "Type
 * imports — Acme Research" becomes "Type imports" on a site titled Acme). A
 * title that is nothing but the site name keeps it.
 */
export const pageTitle = (title: string, siteTitle: string): string => {
  const trimmed = title.trim();
  for (const separator of TITLE_SEPARATORS) {
    const at = trimmed.lastIndexOf(separator);
    if (
      at > 0 &&
      trimmed.slice(at + separator.length).startsWith(siteTitle) &&
      siteTitle
    ) {
      return trimmed.slice(0, at).trim();
    }
  }
  return trimmed;
};

/** A content landmark's HTML as Markdown. */
export const mainToMarkdown = (main: Element): string => {
  const root: Root = { children: cleanChildren(main.children), type: "root" };
  const mdast = toMdast(root);
  return toMarkdown(mdast, {
    bullet: "-",
    extensions: [gfmToMarkdown()],
    listItemIndent: "one",
  }).trim();
};

/**
 * Read one rendered page: its robots directive and date always, and its
 * Markdown when it joins the agent surfaces (see the module comment).
 * `withDocument: false` skips the conversion for a page whose Markdown the
 * build already has (the generated changelog index). `servedPath` is where
 * the page is served, `deployment.base` included, which its JSON-LD names.
 */
export const readBuiltPage = (
  html: string,
  route: string,
  siteTitle: string,
  withDocument = true,
  servedPath = route
): BuiltPage => {
  const tree = fromHtml(html);
  const all = elements(tree);
  const noindex = (metaContent(all, "robots") ?? "")
    .toLowerCase()
    .split(/[\s,]+/u)
    .includes("noindex");
  const page: BuiltPage = { noindex, route };
  const lastModified = lastModifiedOf(all, servedPath);
  if (lastModified) {
    page.lastModified = lastModified;
  }
  const main = all.find(
    (node) =>
      node.tagName === "main" && attribute(node, "id") === "blume-content"
  );
  if (!(withDocument && main) || noindex || isDropped(main)) {
    return page;
  }
  const title = all.find((node) => node.tagName === "title");
  const document: BuiltPageDocument = {
    markdown: mainToMarkdown(main),
    title: pageTitle(title ? textOf(title) : route, siteTitle),
  };
  const description = metaContent(all, "description");
  if (description) {
    document.description = description;
  }
  page.document = document;
  return page;
};

/** Where a static route's HTML lands in the build output. */
const htmlFile = (distDir: string, route: string): string =>
  join(distDir, route.slice(1), "index.html");

/**
 * Read back the pages the content graph can't see: every static custom page
 * (bar the error pages and any route a content page owns), and the generated
 * changelog index. Each reports its robots directive and date, for the
 * sitemap; the custom pages also their Markdown (see {@link readBuiltPage}),
 * except the homepage, whose mirror is the `llms.txt` index, and the
 * changelog index, whose release list already is its mirror. A route with no
 * built HTML is skipped.
 */
export const readBuiltPages = async (
  project: BlumeProject,
  distDir: string
): Promise<BuiltPage[]> => {
  const userPages = project.context.pagesRoot
    ? await discoverPages(project.context.pagesRoot)
    : [];
  const contentRoutes = new Set(
    project.manifest.routes.map((route) => route.path)
  );
  const routes = customStaticRoutes(userPages).filter(
    (route) => !(ERROR_ROUTES.has(route) || contentRoutes.has(route))
  );
  const changelog = hasGeneratedChangelog(project, userPages);
  const deployBase = normalizeBasePath(project.config.deployment.options.base);
  if (changelog) {
    routes.push(CHANGELOG_INDEX_ROUTE);
  }
  const pages = await Promise.all(
    routes.map(async (route) => {
      const file = htmlFile(distDir, route);
      if (!existsSync(file)) {
        return null;
      }
      const withDocument =
        route !== "/" && !(changelog && route === CHANGELOG_INDEX_ROUTE);
      return readBuiltPage(
        await readFile(file, "utf-8"),
        route,
        project.config.title,
        withDocument,
        mountBasePath(deployBase, route)
      );
    })
  );
  return pages.filter((page) => page !== null);
};

/** The built pages that join the agent surfaces. */
export const agentPages = (pages: readonly BuiltPage[]): BuiltAgentPage[] =>
  pages.filter((page): page is BuiltAgentPage => page.document !== undefined);

/**
 * The custom routes whose Markdown copy the build wrote beside the HTML in
 * `staticDir` (see `readBuiltPages`), for the surfaces that negotiate
 * `Accept: text/markdown` after the build: they join the content routes there,
 * so the page answers in Markdown the way a content page does.
 */
export const builtMirrorRoutes = (
  project: BlumeProject,
  staticDir: string
): string[] => {
  const userPages = project.context.pagesRoot
    ? discoverPagesSync(project.context.pagesRoot)
    : [];
  const contentRoutes = new Set(
    project.manifest.routes.map((route) => route.path)
  );
  return customStaticRoutes(userPages).filter(
    (route) =>
      route !== "/" &&
      !contentRoutes.has(route) &&
      existsSync(join(staticDir, `${route.slice(1)}.md`))
  );
};

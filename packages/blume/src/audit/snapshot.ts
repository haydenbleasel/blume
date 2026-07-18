import { createHash } from "node:crypto";

import type { RouteManifestEntry } from "../core/types.ts";
import { attr, metaContents, parseHtml, visibleText } from "./html.ts";
import type { HtmlDocument } from "./html.ts";
import type { PageSnapshot, SnapshotAsset, SnapshotLink } from "./types.ts";

/** Site chrome: links here are navigation, not editorial. */
const CHROME = "nav, aside, header, footer";

/** Where a page's prose lives, in preference order. */
const CONTENT_ROOTS = ["main", "article", "body"];

/**
 * The elements holding the page's prose. Falls back through `main` → `article`
 * → `body` so a custom `.astro` page with no semantic landmark still yields a
 * word count and a content hash instead of silently measuring as empty.
 */
const contentRoot = (document: HtmlDocument) => {
  for (const selector of CONTENT_ROOTS) {
    const found = document.querySelector(selector);
    if (found) {
      return found;
    }
  }
  return null;
};

/**
 * The `<a>` elements that sit in the page's prose rather than its chrome.
 *
 * This split is what makes the link graph mean anything. Blume renders a sidebar
 * linking every nav page from every page, so a graph that treats a sidebar link
 * the same as a body link finds that every page has hundreds of inbound links
 * and no page is ever an orphan.
 */
const contentLinks = (document: HtmlDocument): Set<unknown> => {
  const root = contentRoot(document);
  if (!root) {
    return new Set();
  }
  return new Set(
    root.querySelectorAll("a[href]").filter((anchor) => !anchor.closest(CHROME))
  );
};

const collectAssets = (
  document: HtmlDocument,
  selector: string,
  srcAttr: string
): SnapshotAsset[] =>
  document
    .querySelectorAll(selector)
    .map((element) => ({
      alt: element.getAttribute("alt") ?? null,
      height: attr(element, "height"),
      src: element.getAttribute(srcAttr)?.trim() ?? "",
      width: attr(element, "width"),
    }))
    .filter((asset) => asset.src.length > 0);

/** Parse each JSON-LD block, keeping the parse failures rather than dropping them. */
const collectJsonLd = (
  document: HtmlDocument
): { jsonld: unknown[]; jsonldErrors: string[] } => {
  const jsonld: unknown[] = [];
  const jsonldErrors: string[] = [];
  for (const script of document.querySelectorAll(
    'script[type="application/ld+json"]'
  )) {
    try {
      jsonld.push(JSON.parse(script.rawText));
    } catch (error) {
      jsonldErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { jsonld, jsonldErrors };
};

/** `meta` tags whose key lives in `property` (Open Graph) or `name` (X). */
const prefixedMeta = (
  document: HtmlDocument,
  keyAttr: "property" | "name",
  prefix: string
): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const element of document.querySelectorAll(
    `meta[${keyAttr}^="${prefix}"]`
  )) {
    const key = element.getAttribute(keyAttr)?.trim();
    const content = element.getAttribute("content")?.trim();
    if (key && content) {
      found[key] = content;
    }
  }
  return found;
};

/**
 * Reduce one built HTML page to everything the checks read. Parsed once — every
 * check works off this record, so a page is never re-parsed per check.
 */
export const buildSnapshot = (options: {
  file: string;
  url: string;
  html: string;
  route?: RouteManifestEntry;
}): PageSnapshot => {
  const { file, url, html, route } = options;
  const document = parseHtml(html);

  const inContent = contentLinks(document);
  const links: SnapshotLink[] = document
    .querySelectorAll("a[href]")
    .map((anchor) => ({
      content: inContent.has(anchor),
      href: anchor.getAttribute("href")?.trim() ?? "",
      rel: attr(anchor, "rel"),
      text: anchor.text.trim(),
    }))
    .filter((link) => link.href.length > 0);

  const root = contentRoot(document);
  const prose = root ? visibleText(root) : "";
  const robots = document.querySelector('meta[name="robots"]');
  const { jsonld, jsonldErrors } = collectJsonLd(document);

  return {
    bytes: Buffer.byteLength(html, "utf-8"),
    canonical:
      document
        .querySelector('link[rel="canonical"]')
        ?.getAttribute("href")
        ?.trim() ?? null,
    contentHash: createHash("sha256").update(prose).digest("hex").slice(0, 16),
    descriptions: metaContents(document, 'meta[name="description"]'),
    file,
    headings: document
      .querySelectorAll("h1, h2, h3, h4, h5, h6")
      .map((heading) => ({
        depth: Number(heading.tagName.slice(1)),
        text: heading.text.trim(),
      })),
    hreflang: document
      .querySelectorAll("link[rel=alternate][hreflang]")
      .map((link) => ({
        href: link.getAttribute("href")?.trim() ?? "",
        lang: link.getAttribute("hreflang")?.trim() ?? "",
      }))
      .filter((alternate) => alternate.href && alternate.lang),
    ids: new Set(
      document
        .querySelectorAll("[id]")
        .map((element) => element.getAttribute("id") ?? "")
        .filter((id) => id.length > 0)
    ),
    images: collectAssets(document, "img[src]", "src"),
    // A page is indexable unless it says otherwise. Blume only ever emits
    // `noindex` (never `nofollow`), but an ejected layout could emit either.
    indexable: !robots?.getAttribute("content")?.includes("noindex"),
    jsonld,
    jsonldErrors,
    lang: attr(document.querySelector("html") ?? document, "lang"),
    links,
    metaRefresh:
      document
        .querySelector('meta[http-equiv="refresh" i]')
        ?.getAttribute("content")
        ?.trim() ?? null,
    og: prefixedMeta(document, "property", "og:"),
    robots: robots?.getAttribute("content")?.trim() ?? null,
    route,
    scripts: collectAssets(document, "script[src]", "src"),
    source: route?.sourcePath,
    styles: collectAssets(document, 'link[rel="stylesheet"][href]', "href"),
    titles: document
      .querySelectorAll("title")
      .map((title) => title.text.trim())
      .filter((text) => text.length > 0),
    twitter: prefixedMeta(document, "name", "twitter:"),
    url,
    viewport:
      document
        .querySelector('meta[name="viewport"]')
        ?.getAttribute("content")
        ?.trim() ?? null,
    wordCount: prose ? prose.split(/\s+/u).length : 0,
  };
};

import { readFile, stat } from "node:fs/promises";

import { XMLParser } from "fast-xml-parser";
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import pMap from "p-map";
import { join, relative } from "pathe";
import { glob } from "tinyglobby";

import { examplesRouteBase } from "../astro/templates.ts";
import { stripBasePath } from "../core/base-path.ts";
import type { BlumeManifest, RouteManifestEntry } from "../core/types.ts";
import { buildSnapshot } from "./snapshot.ts";
import type { LlmsDoc, PageSnapshot, RobotsDoc, SitemapDoc } from "./types.ts";

/**
 * The route prefix `<Component />` preview frames live under. They are bare
 * documents rendered for iframes — deliberately noindex, no title worth
 * grading, no front matter to fix — so auditing them as pages only produces
 * findings nobody can act on.
 */
const EXAMPLES_PREFIX = `${examplesRouteBase("")}/`;

/**
 * Ceiling on concurrent file reads/stats while crawling. Unbounded fan-out
 * over a large `dist` risks EMFILE and holds every page's HTML in memory at
 * once.
 */
const CRAWL_CONCURRENCY = 16;

/** Everything read off disk in one pass over the built site. */
export interface CrawlResult {
  pages: PageSnapshot[];
  /** Every file in the static dir: URL path -> size in bytes. */
  files: Map<string, number>;
  sitemap: SitemapDoc | null;
  robots: RobotsDoc | null;
  llms: LlmsDoc | null;
}

/**
 * The URL a built HTML file is served at. Astro's directory build format emits
 * `docs/api/index.html` for `/docs/api`, so the `index.html` leaf collapses;
 * a flat `404.html` keeps its name.
 */
export const fileToUrl = (staticDir: string, file: string): string => {
  const rel = relative(staticDir, file).replaceAll("\\", "/");
  const path = rel.replace(/(?:^|\/)index\.html$/u, "").replace(/\.html$/u, "");
  return path === "" ? "/" : `/${path}`;
};

/**
 * Every file in the static dir, keyed the way an HTML `src`/`href` would name
 * it, with its size — so a reference can be resolved and weighed in one pass.
 */
const indexFiles = async (staticDir: string): Promise<Map<string, number>> => {
  const found = await glob("**/*", { cwd: staticDir, dot: true });
  const sized = await pMap(
    found,
    async (file) => {
      const path = `/${file.replaceAll("\\", "/")}`;
      const info = await stat(join(staticDir, file));
      return [path, info.size] as const;
    },
    { concurrency: CRAWL_CONCURRENCY }
  );
  return new Map(sized);
};

/**
 * Look a built URL up in the route manifest. Routes carry `basePath` while the
 * built file tree may not, so both spellings are tried before giving up — a page
 * that fails to join is still audited, it just can't name a source file to fix.
 */
const routeIndex = (
  manifest: BlumeManifest,
  basePath: string
): Map<string, RouteManifestEntry> => {
  const index = new Map<string, RouteManifestEntry>();
  for (const route of manifest.routes) {
    index.set(route.path, route);
    const stripped = stripBasePath(basePath, route.path);
    if (!index.has(stripped)) {
      index.set(stripped, route);
    }
  }
  return index;
};

/**
 * Sitemaps arrive from arbitrary generators (the audit also fetches remote
 * ones), so parsing is fast-xml-parser's job: CDATA sections, numeric
 * entities, and namespace-prefixed elements are all legal there and all
 * invisible to a regex scan. Values stay strings (`parseTagValue: false`) so
 * a numeric-looking `<lastmod>` isn't coerced.
 */
const sitemapParser = new XMLParser({
  // htmlEntities adds numeric character references (&#38;) on top of the
  // default XML five; a sitemap loc legitimately carries either form.
  htmlEntities: true,
  ignoreAttributes: true,
  parseTagValue: false,
  removeNSPrefix: true,
});

/**
 * What fast-xml-parser produces for a parsed element: a string for text
 * content (`parseTagValue: false`), an object of child elements, an array for
 * a repeated element, or null for a self-closed one.
 */
type XmlValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | XmlValue[]
  | { [element: string]: XmlValue };

/**
 * fast-xml-parser models an element with child elements as an object; a
 * text-only or self-closed element parses to a string or null instead, which
 * these guards reject the same way the crawler always has.
 */
const isUrlsetElement = (value: XmlValue): value is { url?: XmlValue } =>
  typeof value === "object" && value !== null;

const isUrlEntry = (
  value: XmlValue
): value is { lastmod?: XmlValue; loc?: XmlValue } =>
  typeof value === "object" && value !== null;

const isText = (value: XmlValue): value is string => typeof value === "string";

/**
 * Parse `sitemap.xml`. Deliberately shallow: the checks only need the `<loc>`
 * list, each loc's `<lastmod>`, and whether the document is a urlset at all.
 */
export const parseSitemap = (
  file: string,
  xml: string,
  bytes: number
): SitemapDoc => {
  const doc: SitemapDoc = { bytes, file, lastmod: new Map(), urls: [] };
  let parsed: { sitemapindex?: XmlValue; urlset?: XmlValue };
  try {
    parsed = sitemapParser.parse(xml);
  } catch {
    doc.error = "no <urlset> element";
    return doc;
  }
  if (!Object.hasOwn(parsed, "urlset")) {
    doc.error = Object.hasOwn(parsed, "sitemapindex")
      ? "sitemap is an index, not a urlset"
      : "no <urlset> element";
    return doc;
  }
  const { urlset } = parsed;
  const entries = isUrlsetElement(urlset) ? [urlset.url].flat() : [];
  for (const entry of entries) {
    if (!isUrlEntry(entry)) {
      continue;
    }
    const { loc, lastmod } = entry;
    const locText = isText(loc) ? loc.trim() : "";
    if (!locText) {
      continue;
    }
    doc.urls.push(locText);
    if (isText(lastmod) && lastmod.trim() !== "") {
      doc.lastmod?.set(locText, lastmod.trim());
    }
  }
  return doc;
};

/**
 * Parse the `llms.txt` index into its Markdown link targets, with the line
 * each target sits on so findings can point at it. A real parse rather than a
 * `](url)` regex: angle-bracket destinations, link titles, reference-style
 * links (the definition line carries the URL), and autolinks all resolve, and
 * a link-shaped string inside a fenced code block is no longer reported as a
 * claim. Blume's own llms.txt only emits inline links, but the file is also
 * hand-edited.
 */
export const parseLlms = (file: string, text: string): LlmsDoc => {
  const entries: LlmsDoc["entries"] = [];
  const collect = (node: Nodes): void => {
    if (
      (node.type === "link" ||
        node.type === "image" ||
        node.type === "definition") &&
      node.url
    ) {
      entries.push({ line: node.position?.start.line ?? 1, url: node.url });
    }
    if ("children" in node) {
      for (const child of node.children) {
        collect(child);
      }
    }
  };
  collect(fromMarkdown(text));
  return { entries, file };
};

const ROBOTS_DIRECTIVE = /^(?<field>[a-z-]+)\s*:\s*(?<value>.*)$/iu;

/**
 * Parse `robots.txt` into the pieces the audit cares about. Sitemap
 * declarations and a not-a-directive lint come from a line scan; rule
 * *matching* is robots-parser's job at check time (see `checks/robots.ts`),
 * so the raw text rides along instead of a pre-extracted rule list.
 */
export const parseRobots = (file: string, text: string): RobotsDoc => {
  const doc: RobotsDoc = { file, invalid: [], raw: text, sitemaps: [] };
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = ROBOTS_DIRECTIVE.exec(line);
    if (!match) {
      doc.invalid.push({ line: index + 1, text: line });
      continue;
    }
    const field = (match.groups?.field ?? "").toLowerCase();
    const value = (match.groups?.value ?? "").trim();
    if (field === "sitemap" && value) {
      doc.sitemaps.push(value);
    }
  }
  return doc;
};

/**
 * Whether an emitted `.html` file is a real page rather than a fragment.
 *
 * Astro writes standalone HTML for some components (`_home/Footer/index.html`
 * and friends) — markup with no `<html>` or `<head>`, never served as a route.
 * Auditing those as pages reports every one of them as missing a title, a
 * viewport, and a `lang` attribute, which is noise about markup nobody visits.
 * An SEO audit is about documents, so that's what we keep.
 */
const isDocument = (html: string): boolean => /<head[\s>]/iu.test(html);

const readIfPresent = async (file: string): Promise<string | null> => {
  try {
    return await readFile(file, "utf-8");
  } catch {
    return null;
  }
};

/**
 * Read the built site: every HTML page reduced to a snapshot, the full file
 * index (for resolving subresource references), plus sitemap.xml and robots.txt.
 */
export const crawlStaticDir = async (options: {
  staticDir: string;
  manifest: BlumeManifest;
  basePath: string;
}): Promise<CrawlResult> => {
  const { staticDir, manifest, basePath } = options;
  const routes = routeIndex(manifest, basePath);

  const htmlFiles = await glob("**/*.html", { absolute: true, cwd: staticDir });
  const snapshots = await pMap(
    htmlFiles.toSorted(),
    async (file) => {
      const url = fileToUrl(staticDir, file);
      if (stripBasePath(basePath, url).startsWith(EXAMPLES_PREFIX)) {
        return null;
      }
      const html = await readFile(file, "utf-8");
      if (!isDocument(html)) {
        return null;
      }
      return buildSnapshot({
        file,
        html,
        route: routes.get(url) ?? routes.get(stripBasePath(basePath, url)),
        url,
      });
    },
    { concurrency: CRAWL_CONCURRENCY }
  );
  const pages = snapshots.filter((page) => page !== null);

  const sitemapFile = join(staticDir, "sitemap.xml");
  const sitemapXml = await readIfPresent(sitemapFile);
  const robotsFile = join(staticDir, "robots.txt");
  const robotsTxt = await readIfPresent(robotsFile);
  const llmsFile = join(staticDir, "llms.txt");
  const llmsText = await readIfPresent(llmsFile);
  const files = await indexFiles(staticDir);

  return {
    files,
    llms: llmsText === null ? null : parseLlms(llmsFile, llmsText),
    pages,
    robots: robotsTxt === null ? null : parseRobots(robotsFile, robotsTxt),
    sitemap:
      sitemapXml === null
        ? null
        : parseSitemap(
            sitemapFile,
            sitemapXml,
            files.get("/sitemap.xml") ?? Buffer.byteLength(sitemapXml, "utf-8")
          ),
  };
};

import { readFile, stat } from "node:fs/promises";

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
  const sized = await Promise.all(
    found.map(async (file) => {
      const path = `/${file.replaceAll("\\", "/")}`;
      const info = await stat(join(staticDir, file));
      return [path, info.size] as const;
    })
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

const SITEMAP_URL = /<url>(?<block>[\s\S]*?)<\/url>/gu;
const SITEMAP_LOC = /<loc>(?<loc>[\s\S]*?)<\/loc>/gu;
const SITEMAP_LASTMOD = /<lastmod>(?<date>[\s\S]*?)<\/lastmod>/u;
const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&apos;": "'",
  "&gt;": ">",
  "&lt;": "<",
  "&quot;": '"',
};

const unescapeXml = (value: string): string =>
  value.replaceAll(
    /&(?:amp|apos|gt|lt|quot);/gu,
    (entity) => XML_ENTITIES[entity] ?? entity
  );

/**
 * Parse `sitemap.xml`. Deliberately shallow: we only need the `<loc>` list and
 * whether the document is a well-formed urlset, and pulling in an XML parser to
 * learn that would be a dependency for one regex.
 */
export const parseSitemap = (
  file: string,
  xml: string,
  bytes: number
): SitemapDoc => {
  const doc: SitemapDoc = { bytes, file, lastmod: new Map(), urls: [] };
  if (!xml.includes("<urlset")) {
    doc.error = xml.includes("<sitemapindex")
      ? "sitemap is an index, not a urlset"
      : "no <urlset> element";
    return doc;
  }
  for (const match of xml.matchAll(SITEMAP_LOC)) {
    const loc = unescapeXml((match.groups?.loc ?? "").trim());
    if (loc) {
      doc.urls.push(loc);
    }
  }
  // `<lastmod>` is scoped per `<url>` block so it stays attached to its `<loc>`
  // — the flat loc scan above deliberately isn't, so a sitemap with stray text
  // between blocks still yields its URL list.
  for (const match of xml.matchAll(SITEMAP_URL)) {
    const block = match.groups?.block ?? "";
    const loc = unescapeXml(
      (
        new RegExp(SITEMAP_LOC.source, "u").exec(block)?.groups?.loc ?? ""
      ).trim()
    );
    const lastmod = SITEMAP_LASTMOD.exec(block)?.groups?.date?.trim();
    if (loc && lastmod) {
      doc.lastmod?.set(loc, lastmod);
    }
  }
  return doc;
};

/**
 * Parse the `llms.txt` index into its Markdown link targets. Deliberately
 * shallow, like {@link parseSitemap}: the checks only need "which pages does
 * this file claim exist", not a Markdown AST.
 */
export const parseLlms = (file: string, text: string): LlmsDoc => {
  const entries: LlmsDoc["entries"] = [];
  const link = /\]\((?<url>[^)\s]+)\)/gu;
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    for (const match of line.matchAll(link)) {
      const url = match.groups?.url;
      if (url) {
        entries.push({ line: index + 1, url });
      }
    }
  }
  return { entries, file };
};

const ROBOTS_DIRECTIVE = /^(?<field>[a-z-]+)\s*:\s*(?<value>.*)$/iu;

/** Parse `robots.txt` into the directives the audit cares about. */
export const parseRobots = (file: string, text: string): RobotsDoc => {
  const doc: RobotsDoc = { disallow: [], file, invalid: [], sitemaps: [] };
  // Only `User-agent: *` rules bind the crawlers we're auditing for; a block
  // scoped to some other agent isn't a finding about our indexable pages.
  let appliesToAll = false;
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
    if (field === "user-agent") {
      appliesToAll = value === "*";
    } else if (field === "disallow" && appliesToAll && value) {
      doc.disallow.push(value);
    } else if (field === "sitemap" && value) {
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
  const snapshots = await Promise.all(
    htmlFiles.toSorted().map(async (file) => {
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
    })
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

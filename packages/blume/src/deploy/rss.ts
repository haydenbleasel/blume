import { normalizeBasePath, withBasePath } from "../core/base-path.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { PageRecord } from "../core/types.ts";
import { escapeXml } from "./xml.ts";

/** A single feed entry derived from a content page. */
export interface RssItem {
  title: string;
  /** Absolute item URL. */
  link: string;
  description?: string;
  /** Publish date, when the page declares one. */
  date?: Date;
}

/** A resolved RSS feed for one content type. */
export interface RssFeed {
  /** Content type the feed covers, e.g. `blog`. */
  type: string;
  /** Feed URL path, e.g. `/blog/rss.xml`. */
  path: string;
  /** Channel title, e.g. `Blume — Blog`. */
  title: string;
  /** Absolute site link. */
  link: string;
  description?: string;
  items: RssItem[];
}

const capitalize = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

/** Publish date for a page: top-level `date`, else `changelog.date`. */
const pageDate = (page: PageRecord): Date | undefined => {
  const raw = page.meta.date ?? page.meta.changelog?.date;
  if (!raw) {
    return;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

/**
 * Build an RSS feed per configured content type that has publishable pages.
 * Returns an empty list when RSS is disabled or no `deployment.site` is set —
 * absolute URLs are required for a valid feed, mirroring `buildSitemap`.
 */
export const buildRssFeeds = (project: BlumeProject): RssFeed[] => {
  const { config } = project;
  const { rss } = config.seo;
  const { site } = config.deployment;
  if (!(rss.enabled && site)) {
    return [];
  }
  const base = site.replace(/\/$/u, "");
  // Routes carry `basePath`; a `deployment.base` subdirectory is layered on top.
  // The feed's own `link`/self URL points at the docs root under that base, while
  // `path` stays base-less (it's also the on-disk output location).
  const deployBase = normalizeBasePath(config.deployment.base);
  const rootLink = `${base}${deployBase}`;

  const feeds: RssFeed[] = [];
  for (const type of rss.types) {
    const pages = project.graph.pages.filter(
      (page) =>
        page.contentType === type &&
        !(page.meta.draft || page.meta.sidebar.hidden)
    );
    if (pages.length === 0) {
      continue;
    }

    const items: RssItem[] = pages
      .map((page) => ({
        date: pageDate(page),
        description: page.description,
        // Encode like the sitemap does: a route with spaces or non-ASCII
        // must still yield a valid <link>/<guid> URL after XML decoding.
        link: encodeURI(`${base}${withBasePath(deployBase, page.route)}`),
        title: page.title,
      }))
      .toSorted((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))
      .slice(0, rss.limit);

    feeds.push({
      description: config.description,
      items,
      link: rootLink,
      path: `/${type}/rss.xml`,
      title: `${config.title} — ${capitalize(type)}`,
      type,
    });
  }
  return feeds;
};

const renderItem = (item: RssItem): string => {
  const parts = [
    `    <title>${escapeXml(item.title)}</title>`,
    `    <link>${escapeXml(item.link)}</link>`,
    `    <guid isPermaLink="true">${escapeXml(item.link)}</guid>`,
  ];
  if (item.description) {
    parts.push(`    <description>${escapeXml(item.description)}</description>`);
  }
  if (item.date) {
    parts.push(`    <pubDate>${item.date.toUTCString()}</pubDate>`);
  }
  return `  <item>\n${parts.join("\n")}\n  </item>`;
};

/** Serialize a resolved feed into an RSS 2.0 XML document. */
export const renderRssFeed = (feed: RssFeed): string => {
  const feedSelfHref = `${feed.link}${feed.path}`;
  const channel = [
    `  <title>${escapeXml(feed.title)}</title>`,
    `  <link>${escapeXml(feed.link)}</link>`,
    `  <description>${escapeXml(feed.description ?? feed.title)}</description>`,
    `  <atom:link href="${escapeXml(feedSelfHref)}" rel="self" type="application/rss+xml" />`,
  ];
  const items = feed.items.map(renderItem).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
${channel.join("\n")}
${items}
</channel>
</rss>
`;
};

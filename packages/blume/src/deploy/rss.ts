// html-escaper's five-entity table is XML-safe: `'` becomes the numeric
// `&#39;` reference rather than `&apos;`, which XML accepts equally.
import { escape as escapeXml } from "html-escaper";
import { Lexer, Marked } from "marked";

import { mountBasePath, normalizeBasePath } from "../core/base-path.ts";
import {
  authorEntries,
  pageSummary,
  postTags,
  withBlogIndexText,
} from "../core/blog.ts";
import {
  compareEntryDates,
  entryDate,
  parseEntryDate,
} from "../core/dated-list.ts";
import matter from "../core/frontmatter.ts";
import { parseHeadingMarkers } from "../core/heading-markers.ts";
import { EN_UI, resolveUIStrings } from "../core/i18n-ui.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { siteRoot } from "../core/site-url.ts";
import type { PageRecord } from "../core/types.ts";

/** A single feed entry derived from a content page. */
export interface RssItem {
  title: string;
  /** Absolute item URL. */
  link: string;
  description?: string;
  /** Publish date, when the page declares one. */
  date?: Date;
  /** The front matter `authors`' names, each a `dc:creator`. */
  authors?: string[];
  /** The page's `tags`, each a `<category>`. */
  categories?: string[];
  /** The whole page as HTML (`content:encoded`), when `seo.rss.content` is on. */
  content?: string;
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

/** Publish date for a page: `date`, else `changelog.date`, else git's. */
const pageDate = (page: PageRecord): Date | undefined =>
  parseEntryDate(entryDate(page)) ?? undefined;

/** A feed's items of `type`: its pages newest first, cut to the limit. */
const feedPages = (
  project: BlumeProject,
  type: string
): { date: Date | undefined; page: PageRecord }[] => {
  const defaultLocale = project.config.i18n?.defaultLocale;
  return project.graph.pages
    .filter(
      (page) =>
        page.contentType === type &&
        !(page.meta.draft || page.meta.sidebar.hidden) &&
        // The blog's feed carries what its index lists: the current docs in
        // the default locale, so a translated post isn't an item twice.
        (type !== "blog" ||
          (page.version === "" &&
            !page.fallback &&
            (defaultLocale === undefined || page.locale === defaultLocale)))
    )
    .map((page) => ({ date: pageDate(page), page }))
    .toSorted((a, b) => compareEntryDates(a.date ?? null, b.date ?? null))
    .slice(0, project.config.seo.rss.limit);
};

/** The routes of every page a feed carries, which `seo.rss.content` reads. */
export const feedRoutes = (project: BlumeProject): Set<string> =>
  new Set(
    project.config.seo.rss.types.flatMap((type) =>
      feedPages(project, type).map(({ page }) => page.route)
    )
  );

// A paragraph's line that is Blume's own Markdown, which a generic renderer
// would show as written: a callout's `:::` fence (`:::note[Title]`, its
// closing `:::`), indented as a paragraph's line may be.
const DIRECTIVE_FENCE =
  /^[ \t]*:{3,}[\w-]*(?:\[(?<title>[^\]]*)\])?(?:\{[^}]*\})?[ \t]*$/u;
// An href a feed reader can follow: a URL with a scheme, a root path (made
// absolute below), or an anchor (pointed at the page below).
const RESOLVABLE_HREF = /^(?:[a-z][\d+.a-z-]*:|\/|#)/iu;

/**
 * A paragraph's lines as the paragraphs a reader should see: a callout's
 * opening fence as its title (bold, a paragraph of its own), its closing
 * fence gone. Null when it holds neither.
 */
const plainParagraphs = (
  text: string
): { strong: boolean; text: string }[] | null => {
  const lines = text.split("\n");
  if (!lines.some((line) => DIRECTIVE_FENCE.test(line))) {
    return null;
  }
  const paragraphs: { strong: boolean; text: string }[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length > 0) {
      paragraphs.push({ strong: false, text: prose.join("\n") });
      prose = [];
    }
  };
  for (const line of lines) {
    const title = DIRECTIVE_FENCE.exec(line)?.groups?.title?.trim();
    if (DIRECTIVE_FENCE.test(line)) {
      flush();
      if (title) {
        paragraphs.push({ strong: true, text: title });
      }
    } else {
      prose.push(line);
    }
  }
  flush();
  return paragraphs;
};

/**
 * `marked`, reading Blume's own Markdown in a heading or a paragraph as a
 * reader would see it: a heading without its `[#id]` or `[!toc]` marker (a
 * `[toc]` heading, which shows only in the table of contents, gone), and a
 * callout as its title in bold over its text. Code — fenced, indented, in a
 * list or a quote — is `marked`'s own, and stays as written.
 */
const feedMarked = new Marked({
  renderer: {
    heading({ depth, text }) {
      const markers = parseHeadingMarkers(text);
      if (markers.toc === "only") {
        return "";
      }
      return markers.text === text
        ? false
        : `<h${depth}>${this.parser.parseInline(Lexer.lexInline(markers.text))}</h${depth}>\n`;
    },
    // A relative href resolves against nothing a feed reader knows (the
    // mirror already points page links at routes; a one-word footnote,
    // `[^1]: Ibid.`, reads as a link definition): its text stays, unlinked.
    link({ href, tokens }) {
      return RESOLVABLE_HREF.test(href)
        ? false
        : this.parser.parseInline(tokens);
    },
    paragraph({ text }) {
      const paragraphs = plainParagraphs(text);
      return paragraphs === null
        ? false
        : paragraphs
            .map(({ strong, text: line }) => {
              const html = this.parser.parseInline(Lexer.lexInline(line));
              return `<p>${strong ? `<strong>${html}</strong>` : html}</p>\n`;
            })
            .join("");
    },
  },
});

/**
 * A page's Markdown as feed HTML: its front matter off, rendered, and every
 * root-relative `href`/`src` made absolute and every in-page anchor a link to
 * the page, since a feed reader resolves nothing against the site.
 */
const pageHtml = (markdown: string, origin: string, link: string): string =>
  feedMarked
    .parse(matter(markdown).content, { async: false })
    .replaceAll(
      /(?<attribute>\s(?:href|src)=["'])\/(?!\/)/gu,
      `$<attribute>${origin}/`
    )
    .replaceAll(/(?<attribute>\shref=["'])#/gu, `$<attribute>${link}#`)
    .trim();

/** The blog feed's title word: the blog's title in the default locale. */
const blogTitle = (project: BlumeProject): string => {
  const { i18n } = project.config;
  const ui = i18n
    ? resolveUIStrings(i18n.defaultLocale, {
        defaultLocale: i18n.defaultLocale,
        overrides: i18n.ui,
      })
    : EN_UI;
  return withBlogIndexText(project.config, ui, i18n?.defaultLocale).blog.title;
};

/**
 * Build an RSS feed per configured content type that has publishable pages.
 * Returns an empty list when RSS is disabled or no `deployment.site` is set —
 * absolute URLs are required for a valid feed, mirroring `buildSitemap`.
 *
 * `markdown` (each route's Markdown mirror) fills in every item's whole page
 * when `seo.rss.content` asks for it; callers that only list the feeds pass
 * none.
 */
export const buildRssFeeds = (
  project: BlumeProject,
  markdown?: Readonly<Record<string, string>>
): RssFeed[] => {
  const { config } = project;
  const { rss } = config.seo;
  const { site } = config.deployment.options;
  if (!(rss.enabled && site)) {
    return [];
  }
  const base = siteRoot(site);
  // Routes carry `basePath`; a `deployment.base` subdirectory is mounted on top
  // of every one, even a route whose first segment matches it (see sitemap.ts).
  // The feed's own `link`/self URL points at the docs root under that base, while
  // `path` stays base-less (it's also the on-disk output location).
  const deployBase = normalizeBasePath(config.deployment.options.base);
  const rootLink = `${base}${deployBase}`;

  const feeds: RssFeed[] = [];
  for (const type of rss.types) {
    const pages = feedPages(project, type);
    if (pages.length === 0) {
      continue;
    }

    const items: RssItem[] = pages.map(({ date, page }) => {
      const item: RssItem = {
        date,
        // A page with only a meta description (a GitHub release, whose
        // summary goes in `seo.description`) still describes its item, and
        // a blog post without either its first paragraph.
        description: pageSummary(page),
        // Encode like the sitemap does: a route with spaces or non-ASCII
        // must still yield a valid <link>/<guid> URL after XML decoding.
        link: encodeURI(`${base}${mountBasePath(deployBase, page.route)}`),
        title: page.title,
      };
      const authors = authorEntries(page.meta.authors);
      if (authors.length > 0) {
        item.authors = authors.map((author) => author.name);
      }
      // One category per tag, as the index and the tag pages read them.
      const tags = postTags(page.meta.tags);
      if (tags.length > 0) {
        item.categories = tags.map((tag) => tag.label);
      }
      const source = rss.content ? markdown?.[page.route] : undefined;
      if (source !== undefined) {
        item.content = pageHtml(source, base, item.link);
      }
      return item;
    });

    feeds.push({
      description: config.description,
      items,
      link: rootLink,
      path: `/${type}/rss.xml`,
      title: `${config.title} — ${type === "blog" ? blogTitle(project) : capitalize(type)}`,
      type,
    });
  }
  return feeds;
};

// Characters XML 1.0 can't carry, escaped or not: control characters other
// than tab and line breaks (a pasted terminal escape), and U+FFFE/U+FFFF. One
// in a post would leave the whole feed unparseable.
const XML_FORBIDDEN = /(?![\t\n\r])[\p{Cc}\uFFFE\uFFFF]/gu;

/** Text as XML character data: escaped, and without what XML can't hold. */
const xmlText = (value: string): string =>
  escapeXml(value.replaceAll(XML_FORBIDDEN, ""));

const renderItem = (item: RssItem): string => {
  const parts = [
    `    <title>${xmlText(item.title)}</title>`,
    `    <link>${xmlText(item.link)}</link>`,
    `    <guid isPermaLink="true">${xmlText(item.link)}</guid>`,
  ];
  if (item.description) {
    parts.push(`    <description>${xmlText(item.description)}</description>`);
  }
  if (item.date) {
    parts.push(`    <pubDate>${item.date.toUTCString()}</pubDate>`);
  }
  for (const author of item.authors ?? []) {
    parts.push(`    <dc:creator>${xmlText(author)}</dc:creator>`);
  }
  for (const category of item.categories ?? []) {
    parts.push(`    <category>${xmlText(category)}</category>`);
  }
  if (item.content) {
    parts.push(
      `    <content:encoded>${xmlText(item.content)}</content:encoded>`
    );
  }
  return `  <item>\n${parts.join("\n")}\n  </item>`;
};

/** Serialize a resolved feed into an RSS 2.0 XML document. */
export const renderRssFeed = (feed: RssFeed): string => {
  const feedSelfHref = `${feed.link}${feed.path}`;
  const channel = [
    `  <title>${xmlText(feed.title)}</title>`,
    `  <link>${xmlText(feed.link)}</link>`,
    `  <description>${xmlText(feed.description ?? feed.title)}</description>`,
    `  <atom:link href="${xmlText(feedSelfHref)}" rel="self" type="application/rss+xml" />`,
  ];
  const items = feed.items.map(renderItem).join("\n");
  // The modules' namespaces are declared only where an item uses them.
  const namespaces = [
    ` xmlns:atom="http://www.w3.org/2005/Atom"`,
    feed.items.some((item) => item.content)
      ? ` xmlns:content="http://purl.org/rss/1.0/modules/content/"`
      : "",
    feed.items.some((item) => item.authors)
      ? ` xmlns:dc="http://purl.org/dc/elements/1.1/"`
      : "",
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"${namespaces}>
<channel>
${channel.join("\n")}
${items}
</channel>
</rss>
`;
};

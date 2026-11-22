import type { UIStrings } from "./i18n-ui.ts";
import { resolveLocalizable } from "./localizable.ts";
import type { DatedGroups } from "./navigation.ts";
import type { LocalizableLabel, ResolvedConfig } from "./schema.ts";
import type { PageRecord } from "./types.ts";

/**
 * The blog: `type: blog` pages, which Blume lists at a generated `/blog`
 * index (newest first, grouped by year) with a page per tag, and gives a
 * byline, a cover, and links to the posts around them. Everything that lists
 * posts — the index, the tag pages, a post's footer, the `/blog.md` mirror,
 * the feed, the OG cards — reads the same {@link BlogPost}s (built at
 * generate time by `blog-posts.ts`), so they agree on what a post's date,
 * excerpt, authors, and tags are. This module is the policy they share, safe
 * to import on both sides.
 */

/** Where the blog index is served. */
export const BLOG_INDEX_ROUTE = "/blog";

/** Where the tag pages are served, one per tag: `/blog/tags/<slug>`. */
export const BLOG_TAGS_ROUTE = "/blog/tags";

/** A post author as the byline shows them. */
export interface BlogAuthor {
  /** The avatar's URL, as the page emits it. */
  avatar?: string;
  name: string;
  url?: string;
}

/** A tag: its label as written, and the slug its page is served under. */
export interface BlogTag {
  label: string;
  slug: string;
}

/** A post's cover image. */
export interface BlogCover {
  alt: string;
  /** The image's URL, as the page emits it. */
  src: string;
  /**
   * The image file on the build machine, for the OG card, when it's local.
   * Never serialized into page data.
   */
  file?: string;
}

/** A blog post, as every surface that lists or frames one reads it. */
export interface BlogPost {
  /** The served route (`basePath` and locale included, deployment base not). */
  route: string;
  locale: string;
  /** `""` for the current docs, else the archived version's id. */
  version: string;
  /** Whether the route renders another locale's post as a fallback. */
  fallback: boolean;
  /** Whether the post is kept out of the index (`sidebar.hidden`). */
  hidden: boolean;
  title: string;
  /** The post's description, else its first paragraph. */
  excerpt: string | null;
  /** The publish date as an ISO timestamp: front matter `date`, else git's. */
  date: string | null;
  authors: BlogAuthor[];
  tags: BlogTag[];
  cover: BlogCover | null;
  /** Estimated reading time in minutes. */
  readingTime: number;
}

/**
 * A tag's URL segment: lowercased, every run of characters that isn't a
 * letter, a mark, or a digit made one dash. Letters in any script stay as
 * they are, with their combining marks (`हिन्दी`), so `Säkerhet` is `säkerhet`.
 * Tags that differ only in case or punctuation (`DevOps`, `devops`) share a
 * page; one with no letters or digits at all is `tag`.
 */
export const blogTagSlug = (label: string): string =>
  label
    .normalize("NFC")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "") || "tag";

/** The route of a tag's page. */
export const blogTagRoute = (slug: string): string =>
  `${BLOG_TAGS_ROUTE}/${slug}`;

/** A post's front matter `tags`, each slug once (the first spelling wins). */
export const postTags = (labels?: readonly string[]): BlogTag[] => {
  const seen = new Set<string>();
  const tags: BlogTag[] = [];
  for (const label of labels ?? []) {
    const slug = blogTagSlug(label);
    if (!seen.has(slug)) {
      seen.add(slug);
      tags.push({ label, slug });
    }
  }
  return tags;
};

/** `text`, unless it's empty or only whitespace. */
export const nonBlank = (text: string | undefined): string | undefined =>
  text?.trim() ? text : undefined;

/**
 * A page's summary wherever it's listed: its description, else its meta
 * description, else — for a blog post — its first paragraph. A blank one
 * (`description: ""`) is no summary.
 */
export const pageSummary = (
  page: Pick<PageRecord, "description" | "meta" | "post">
): string | undefined =>
  nonBlank(page.description) ??
  nonBlank(page.meta.seo.description) ??
  page.post?.excerpt;

/** Whether a front matter `authors` or `cover` entry is the bare string form. */
const isBare = <Value>(value: Value): value is Extract<Value, string> =>
  typeof value === "string";

/** A front matter author: the name, and the avatar path and URL as written. */
export interface AuthorEntry {
  avatar?: string;
  name: string;
  url?: string;
}

/**
 * The front matter `authors` — a name, an object, or a list of either — as
 * entries. An object's `image` is read as its `avatar`. A blank name is no
 * author to credit.
 */
export const authorEntries = (
  authors?: PageRecord["meta"]["authors"]
): AuthorEntry[] =>
  (authors === undefined ? [] : [authors].flat())
    .map((author) => {
      if (isBare(author)) {
        return { name: author };
      }
      const entry: AuthorEntry = { name: author.name };
      const avatar = author.avatar ?? author.image;
      if (avatar) {
        entry.avatar = avatar;
      }
      if (author.url) {
        entry.url = author.url;
      }
      return entry;
    })
    .filter((entry) => entry.name.trim() !== "");

/** The front matter `cover` as a path or URL and its alt text, if any. */
export const coverEntry = (
  cover?: PageRecord["meta"]["cover"]
): { alt?: string; src: string } | null => {
  if (cover === undefined) {
    return null;
  }
  return isBare(cover) ? { src: cover } : cover;
};

/**
 * The posts the index lists: the current docs' own posts in the default
 * locale, none hidden. Like the changelog, the index is one list whatever
 * locale reads it, and a fallback copy would only list a post twice.
 */
export const indexedPosts = <
  Post extends Pick<BlogPost, "fallback" | "hidden" | "locale" | "version">,
>(
  posts: readonly Post[],
  defaultLocale: string | null
): Post[] =>
  posts.filter(
    (post) =>
      !(post.fallback || post.hidden) &&
      post.version === "" &&
      (defaultLocale === null || post.locale === defaultLocale)
  );

/** A tag with the number of indexed posts that carry it. */
export interface BlogTagCount extends BlogTag {
  count: number;
}

/**
 * The tags of `posts`, most used first (then by label). Each slug is one tag,
 * labeled the way its newest post spells it.
 */
export const blogTags = (
  posts: readonly Pick<BlogPost, "tags">[]
): BlogTagCount[] => {
  const bySlug = new Map<string, BlogTagCount>();
  for (const post of posts) {
    for (const tag of post.tags) {
      const known = bySlug.get(tag.slug);
      if (known) {
        known.count += 1;
      } else {
        bySlug.set(tag.slug, { ...tag, count: 1 });
      }
    }
  }
  return [...bySlug.values()].toSorted(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label, "en")
  );
};

/** A scanned page, as far as the index's policy reads it. */
type ScannedPost = Pick<
  PageRecord,
  "contentType" | "fallback" | "locale" | "meta" | "version"
>;

/**
 * The scanned pages the index lists, read straight off the scan so the
 * content graph can count the index and tag routes as served before any post
 * is built.
 */
const listedPages = (
  pages: readonly ScannedPost[],
  defaultLocale: string | null
) =>
  indexedPosts(
    pages
      .filter((page) => page.contentType === "blog")
      .map((page) => ({
        fallback: page.fallback ?? false,
        hidden: page.meta.draft || page.meta.sidebar.hidden,
        locale: page.locale,
        tags: postTags(page.meta.tags),
        version: page.version,
      })),
    defaultLocale
  );

/**
 * Whether the site serves a blog index at {@link BLOG_INDEX_ROUTE}: there are
 * posts for it to list (the current docs' own posts in the default locale).
 * Blume generates the index there unless a custom or content page owns the
 * route — either way the route is servable, which is what navigation needs to
 * point a `/blog` tab at the index.
 */
export const hasBlogIndex = (
  pages: readonly ScannedPost[],
  defaultLocale: string | null
): boolean => listedPages(pages, defaultLocale).length > 0;

/** The routes of the tag pages Blume generates: one per tag the index lists. */
export const blogTagRoutes = (
  pages: readonly ScannedPost[],
  defaultLocale: string | null
): string[] =>
  blogTags(listedPages(pages, defaultLocale)).map((tag) =>
    blogTagRoute(tag.slug)
  );

/** The posts on either side of a post by date. */
export interface AdjacentPosts<Post> {
  /** The next more recent post. */
  newer: Post | null;
  /** The post published before it. */
  older: Post | null;
}

/**
 * The dated posts before and after `route` by date, among the posts of its
 * locale and version. Null for an undated post (or none): it pages as the
 * sidebar orders it, by filename.
 */
export const adjacentPosts = <Post extends BlogPost>(
  posts: readonly Post[],
  route: string
): AdjacentPosts<Post> | null => {
  const current = posts.find((post) => post.route === route);
  if (!current?.date) {
    return null;
  }
  const siblings = posts.filter(
    (post) =>
      post.date !== null &&
      !post.hidden &&
      post.locale === current.locale &&
      post.version === current.version
  );
  const index = siblings.indexOf(current);
  return {
    newer: index > 0 ? (siblings[index - 1] ?? null) : null,
    older: index === -1 ? null : (siblings[index + 1] ?? null),
  };
};

/** The most posts a post suggests at its foot when it names none itself. */
export const RELATED_POSTS = 3;

/**
 * The posts that share the most tags with `route`'s post, newest first among
 * equals, from the posts of its locale and version: what a post suggests at
 * its foot when its front matter names no `related` pages.
 */
export const relatedPosts = <Post extends BlogPost>(
  posts: readonly Post[],
  route: string
): Post[] => {
  const current = posts.find((post) => post.route === route);
  const slugs = new Set(current?.tags.map((tag) => tag.slug));
  if (!current || slugs.size === 0) {
    return [];
  }
  return posts
    .filter(
      (post) =>
        post !== current &&
        !post.hidden &&
        post.locale === current.locale &&
        post.version === current.version
    )
    .map((post) => ({
      post,
      shared: post.tags.filter((tag) => slugs.has(tag.slug)).length,
    }))
    .filter(({ shared }) => shared > 0)
    .toSorted((a, b) => b.shared - a.shared)
    .slice(0, RELATED_POSTS)
    .map(({ post }) => post);
};

/**
 * A locale's UI strings with the index's title and description taken from
 * the `blog` config where it sets them (a string, or a per-locale map), so
 * every surface that reads the `blog` strings (the index, its OG card, its
 * Markdown mirror, the feed) agrees.
 */
export const withBlogIndexText = (
  config: Pick<ResolvedConfig, "blog" | "i18n">,
  ui: UIStrings,
  locale?: string
): UIStrings => {
  const text = (label: LocalizableLabel | undefined, fallback: string) =>
    label === undefined
      ? fallback
      : resolveLocalizable(label, locale, config.i18n?.defaultLocale);
  return {
    ...ui,
    blog: {
      ...ui.blog,
      description: text(config.blog?.description, ui.blog.description),
      title: text(config.blog?.title, ui.blog.title),
    },
  };
};

/**
 * How each dated type's entries group in the sidebar: blog posts by year
 * unless `blog.sidebar.groupBy` says otherwise, changelog entries only when
 * `changelog.sidebar.groupBy` asks.
 */
export const datedSidebarGroups = (
  config: Pick<ResolvedConfig, "blog" | "changelog">
): DatedGroups => {
  const groups: DatedGroups = {};
  const blog = config.blog?.sidebar.groupBy ?? "year";
  if (blog) {
    groups.blog = blog;
  }
  const changelog = config.changelog?.sidebar.groupBy ?? false;
  if (changelog) {
    groups.changelog = changelog;
  }
  return groups;
};

/**
 * Up to two initials for an author shown without an avatar — the first and
 * last word's (`Ada Lovelace` is `AL`) — by code point, so a name that opens
 * with an emoji or an astral letter keeps it whole.
 */
export const authorInitials = (name: string): string => {
  const words = name
    .trim()
    .split(/\s+/u)
    // Past an opening bracket or quote: `(Acme)` is `A`, a lone `—` nothing.
    .map((word) => word.replace(/^\p{P}+/u, ""))
    .filter(Boolean);
  const picked = words.length > 1 ? [words[0], words.at(-1)] : words;
  return (
    picked
      .map((word) => [...(word ?? "")][0] ?? "")
      .join("")
      // Not the build machine's locale: a Turkish one would turn `i` into `İ`.
      .toUpperCase()
  );
};

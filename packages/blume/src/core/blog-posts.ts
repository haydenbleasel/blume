import { join } from "pathe";

import {
  isExternalUrl,
  normalizeBasePath,
  withAuthoredBasePath,
  withBasePath,
} from "./base-path.ts";
import { authorEntries, coverEntry, pageSummary, postTags } from "./blog.ts";
import type { BlogAuthor, BlogCover, BlogPost } from "./blog.ts";
import { resolvePostImage } from "./content-assets.ts";
import { compareEntryDates, entryDate, parseEntryDate } from "./dated-list.ts";
import { resolveFallbackLocale } from "./i18n.ts";
import { localizeHref, routeSetFor, servesRoute } from "./locale-links.ts";
import { targetPath } from "./relative-files.ts";
import type { ResolvedConfig } from "./schema.ts";
import type { PageRecord, RouteManifestEntry } from "./types.ts";

/**
 * Build the {@link BlogPost}s every blog surface reads, from the scanned
 * pages: dates parsed, excerpts and reading times taken from the scan, tags
 * slugged, and images resolved to the URLs the page emits. Node-side only —
 * it reads the file system to find images beside a post.
 */

/** What resolving a post's images needs from the project. */
interface ImageContext {
  deployBase: string;
  root: string;
  sourcePath?: string;
}

/** A link a post names (an author's `url`), as its page in `locale` emits it. */
type SiteLink = (url: string, locale: string) => string;

/** An image as the page emits it, and the local file behind it, if any. */
interface PostImage {
  file?: string;
  src: string;
}

/**
 * An image a post names in front matter, as the page emits it: a URL passes
 * through, a root path (`/images/a.png`, under `public/`) takes the
 * deployment base, and a path beside the post (`./a.png`) is served from
 * `/blume-assets/content/` like the post's own images. `file` is the local
 * file the OG card can read; null when a relative path names no file.
 */
const postImage = (value: string, context: ImageContext): PostImage | null => {
  if (isExternalUrl(value) || value.startsWith("data:")) {
    return { src: value };
  }
  if (value.startsWith("/")) {
    return {
      file: join(context.root, "public", targetPath(value)),
      src: withBasePath(context.deployBase, value),
    };
  }
  const served = context.sourcePath
    ? resolvePostImage(value, {
        deployBase: context.deployBase,
        projectRoot: context.root,
        sourcePath: context.sourcePath,
      })
    : null;
  return served ? { file: served.file, src: served.src } : null;
};

const postAuthors = (
  page: PageRecord,
  context: ImageContext,
  link: SiteLink,
  locale: string
): BlogAuthor[] =>
  authorEntries(page.meta.authors).map(({ avatar, url, ...author }) => {
    const entry: BlogAuthor = author;
    const image = avatar ? postImage(avatar, context) : null;
    if (image) {
      entry.avatar = image.src;
    }
    if (url) {
      entry.url = link(url, locale);
    }
    return entry;
  });

const postCover = (
  page: PageRecord,
  context: ImageContext
): BlogCover | null => {
  const cover = coverEntry(page.meta.cover);
  const image = cover ? postImage(cover.src, context) : null;
  // Unlabeled, the cover is the post's own picture: its title describes it
  // better than nothing.
  return image ? { ...image, alt: cover?.alt ?? page.title } : null;
};

/**
 * One page's post, or null when it isn't a blog post. `locale` is the
 * language its page is served in: a fallback copy's, not its source's.
 */
const blogPost = (
  page: PageRecord,
  context: { deployBase?: string; link: SiteLink; root: string },
  locale = page.locale
): BlogPost | null => {
  if (page.contentType !== "blog") {
    return null;
  }
  const images: ImageContext = {
    deployBase: normalizeBasePath(context.deployBase),
    root: context.root,
    sourcePath: page.sourcePath,
  };
  const date = parseEntryDate(entryDate(page));
  return {
    authors: postAuthors(page, images, context.link, locale),
    cover: postCover(page, images),
    date: date ? date.toISOString() : null,
    excerpt: pageSummary(page) ?? null,
    fallback: page.fallback ?? false,
    hidden: page.meta.draft || page.meta.sidebar.hidden,
    locale: page.locale,
    readingTime: page.post?.readingTime ?? 1,
    route: page.route,
    tags: postTags(page.meta.tags),
    title: page.title,
    version: page.version,
  };
};

/** Newest first; undated posts last, in title order. */
const comparePosts = (a: BlogPost, b: BlogPost): number =>
  compareEntryDates(parseEntryDate(a.date), parseEntryDate(b.date)) ||
  a.title.localeCompare(b.title, "en");

/**
 * Every blog post the project serves — each locale and version, fallback
 * copies included, so any post's page finds its own byline — newest first.
 */
export const blogPosts = (project: {
  config: Pick<ResolvedConfig, "basePath" | "deployment" | "i18n">;
  context: { root: string };
  graph: { pages: PageRecord[] };
  manifest: {
    routes: readonly Pick<
      RouteManifestEntry,
      "fallback" | "id" | "locale" | "path"
    >[];
  };
}): BlogPost[] => {
  const { basePath, i18n } = project.config;
  const deployBase = normalizeBasePath(project.config.deployment.options.base);
  const routes = routeSetFor(project.manifest.routes);
  // A root path (`/team/ada`) is a page on this site, linked as a body link
  // to it is: under the site's bases, and in the post's language where that
  // page is translated.
  const link: SiteLink = (url, locale) => {
    const based = withAuthoredBasePath(deployBase, basePath, url, (route) =>
      servesRoute(routes, route)
    );
    return i18n
      ? localizeHref(based, { basePath, deployBase, i18n, locale, routes })
      : based;
  };
  const context = { deployBase, link, root: project.context.root };
  const posts = project.graph.pages.flatMap((page) => {
    const post = blogPost(page, context);
    return post ? [post] : [];
  });
  // A post a locale hasn't translated is served there as a copy of the
  // fallback locale's (only the manifest lists those routes), and its page
  // reads its byline here like any other.
  const fallbackLocale = i18n ? resolveFallbackLocale(i18n) : null;
  const sources = new Map(
    project.graph.pages.flatMap((page) =>
      page.locale === fallbackLocale ? [[page.id, page] as const] : []
    )
  );
  const copies = project.manifest.routes.flatMap((route) => {
    const source = route.fallback ? sources.get(route.id) : undefined;
    const post = source ? blogPost(source, context, route.locale) : null;
    return post
      ? [{ ...post, fallback: true, locale: route.locale, route: route.path }]
      : [];
  });
  return [...posts, ...copies].toSorted(comparePosts);
};

/**
 * Each post's cover as its OG card reads it, by route: the local file when
 * there is one, else the URL the page shows, a protocol-relative one
 * (`//cdn…`) over HTTPS, as a browser on the site would fetch it.
 */
export const blogCoverSources = (
  posts: readonly BlogPost[]
): Record<string, string> =>
  Object.fromEntries(
    posts.flatMap((post) => {
      if (!post.cover) {
        return [];
      }
      const { file, src } = post.cover;
      return [[post.route, file ?? src.replace(/^\/\//u, "https://")]];
    })
  );

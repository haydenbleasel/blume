import { normalizeBasePath } from "../core/base-path.ts";
import { blogPosts } from "../core/blog-posts.ts";
import {
  blogTagSlug,
  hasBlogIndex,
  indexedPosts,
  withBlogIndexText,
} from "../core/blog.ts";
import type { BlogPost } from "../core/blog.ts";
import {
  isoDateFormat,
  isoDayYear,
  resolveDateFormatOptions,
} from "../core/date-format.ts";
import { groupEntryYears } from "../core/dated-list.ts";
import { EN_UI, resolveUIStrings } from "../core/i18n-ui.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { isString } from "./component-markdown.ts";
import type { ComponentMarkdown } from "./component-markdown.ts";
import { linkText, pageUrl, routeTarget } from "./link-text.ts";

/**
 * The generated `/blog` index as Markdown, for its `/blog.md` mirror and MCP
 * `get_page`: what the index page lists — every post of the current docs in
 * the default locale, newest first, grouped by year — one entry each, with its
 * date, authors, and tags, and its excerpt beneath.
 */

/** Who reads the list: the assistant's snapshot, or an agent fetching a URL. */
interface IndexOptions {
  assistant?: boolean;
}

/**
 * A post's link: absolute under a configured site, like llms.txt — or, for
 * the assistant's snapshot, the route alone, as its excerpts link pages.
 */
const postUrl = (
  project: BlumeProject,
  route: string,
  { assistant = false }: IndexOptions
): string => {
  if (assistant) {
    return routeTarget(route);
  }
  const { base, site } = project.config.deployment.options;
  return pageUrl(route, site, normalizeBasePath(base));
};

/**
 * Plain text as Markdown that reads as written, on its entry's line: its
 * whitespace collapsed (a multi-line description would leave the list), its
 * inline syntax escaped, and a marker that would open a heading or a list at
 * the start of the line.
 */
const markdownText = (text: string): string =>
  text
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replaceAll(/[\\`*_[\]<>|]/gu, String.raw`\$&`)
    .replace(/^[#+-]/u, String.raw`\$&`)
    .replace(
      /^(?<digits>\d+)(?<marker>[.)])/u,
      String.raw`$<digits>\$<marker>`
    );

const postEntry = (
  project: BlumeProject,
  post: BlogPost,
  day: string | null,
  options: IndexOptions
): string => {
  const details = [
    day ?? "",
    post.authors.map((author) => author.name).join(", "),
    post.tags.map((tag) => tag.label).join(", "),
  ].filter(Boolean);
  const tail =
    details.length > 0 ? ` — ${markdownText(details.join(" · "))}` : "";
  const line = `- [${linkText(post.title)}](${postUrl(project, post.route, options)})${tail}`;
  return post.excerpt ? `${line}\n  ${markdownText(post.excerpt)}` : line;
};

/**
 * The post list alone, as year headings over linked entries — what `<Blog />`
 * renders, in Markdown (`tag`, a tag's slug or label, keeps that tag's
 * posts). Split out of the document below so the component's serializer
 * publishes exactly the list the generated page's mirror does.
 */
export const blogIndexBlocks = (
  project: BlumeProject,
  tag?: string,
  options: IndexOptions = {}
): string[] => {
  const slug = tag === undefined ? undefined : blogTagSlug(tag);
  const posts = indexedPosts(
    blogPosts(project),
    project.config.i18n?.defaultLocale ?? null
  ).filter(
    (post) =>
      slug === undefined || post.tags.some((entry) => entry.slug === slug)
  );
  // Each date the day it is in the configured time zone, as on the page.
  const iso = isoDateFormat(
    resolveDateFormatOptions(project.config.dateFormat).timeZone
  );
  const days = posts.map((post) => ({
    day: post.date ? iso(new Date(post.date)) : null,
    post,
  }));
  // Undated posts sort last, under a heading of their own.
  return groupEntryYears(days, (entry) =>
    entry.day ? isoDayYear(entry.day) : null
  ).flatMap((group) => [
    `## ${group.year ?? "Undated"}`,
    group.items
      .map((entry) => postEntry(project, entry.post, entry.day, options))
      .join("\n"),
  ]);
};

export const buildBlogIndexMarkdown = (project: BlumeProject): string => {
  const { i18n } = project.config;
  const ui = withBlogIndexText(
    project.config,
    i18n
      ? resolveUIStrings(i18n.defaultLocale, {
          defaultLocale: i18n.defaultLocale,
          overrides: i18n.ui,
        })
      : EN_UI,
    i18n?.defaultLocale
  );
  const blocks = [
    `# ${ui.blog.title}`,
    ui.blog.description,
    ...blogIndexBlocks(project),
  ];
  return `${blocks.join("\n\n")}\n`;
};

/**
 * Downlevel `<Blog />` to the post list it renders, so a hand-written page
 * that owns `/blog` publishes the same list the generated index's mirror does
 * (see `changelog-components.ts` for why a tag without a serializer would
 * reach agents as written). `<Blog tag="…" />` keeps that tag's posts. On a
 * site with no posts to list, the tag stays as written: there `<Blog>` is
 * likelier the site's own component. For the assistant's snapshot its links
 * are routes, like the rest of its excerpts.
 */
export const blogComponentSerializers = (
  project: BlumeProject,
  options: IndexOptions = {}
) =>
  ({
    Blog: ({ props }) =>
      hasBlogIndex(
        project.graph.pages,
        project.config.i18n?.defaultLocale ?? null
      )
        ? blogIndexBlocks(
            project,
            isString(props.tag) ? props.tag : undefined,
            options
          ).join("\n\n")
        : null,
  }) satisfies Record<string, ComponentMarkdown>;

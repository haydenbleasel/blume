import { readFile } from "node:fs/promises";

import type { Nodes } from "mdast";
import { mdxToMdast } from "satteri";

import { hasGeneratedBlog, hasGeneratedChangelog } from "../astro/pages.ts";
import { BLOG_INDEX_ROUTE } from "../core/blog.ts";
import { CHANGELOG_INDEX_ROUTE } from "../core/changelog-index.ts";
import {
  frontMatterImages,
  rewriteRelativeAssets,
} from "../core/content-assets.ts";
import { discoverPages, discoverPagesSync } from "../core/custom-pages.ts";
import matter from "../core/frontmatter.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { withoutJsxComments } from "../core/sources/normalize.ts";
import { readExpandedEntryText } from "../core/sources/read.ts";
import type { PageRecord, RouteManifestEntry } from "../core/types.ts";
import { feedRoutes } from "../deploy/rss.ts";
import { MDX_FEATURES } from "../markdown/features.ts";
import { advertisedConfig, servesMcp } from "./agent-surface.ts";
import { buildBlogIndexMarkdown } from "./blog-markdown.ts";
import { buildChangelogIndexMarkdown } from "./changelog-markdown.ts";
import { downlevelComponents } from "./component-markdown.ts";
import { buildLlmsIndex } from "./llms.ts";
import { relativeLinkRewriter } from "./relative-links.ts";
import { projectComponentSerializers } from "./serializers.ts";
import { servesSkillsIndex } from "./skills.ts";
import { applyAudienceVisibility } from "./visibility.ts";
import type { VisibilityAudience } from "./visibility.ts";

/** One route's raw-Markdown variants. */
export interface RawMarkdownEntry {
  /**
   * The agent-facing Markdown served at `/<route>.md`: supported components
   * downleveled to plain Markdown (`<TypeTable>` → table, `<Callout>` →
   * blockquote, …). Present only when downleveling changed something, so
   * component-free pages aren't stored twice.
   */
  md?: string;
  /** The original source, served verbatim at `/<route>.mdx`. */
  mdx: string;
}

/** The Markdown an agent should read for a route. */
export const agentMarkdown = (entry: RawMarkdownEntry): string =>
  entry.md ?? entry.mdx;

/**
 * Estimated token count of a Markdown document, for the `x-markdown-tokens`
 * response header (the convention Cloudflare's Markdown for Agents ships; the
 * tokenizer is unspecified there too, so this is the common ~4-characters-
 * per-token estimate). Kept in sync with the inline computation in
 * `rawMarkdownEndpointTemplate`, which can't import build-time code.
 */
export const markdownTokenCount = (text: string): number =>
  Math.ceil(text.length / 4);

/**
 * Read routes' pages as Markdown for one audience: include-expanded, relative
 * images and files rewritten to their served `/blume-assets/content/…` URLs,
 * relative page links to the routes they mean (see `relative-links.ts`),
 * `<Visibility>` resolved for `audience`, and — in `md` — supported
 * components downleveled. Built once per pass, then called per route.
 */
const routeMarkdownReader = (project: BlumeProject) => {
  const pageById = new Map(project.graph.pages.map((page) => [page.id, page]));
  const components = projectComponentSerializers(project);
  const rewriteLinks = relativeLinkRewriter(project);

  const readRoute = async (
    route: RouteManifestEntry,
    page: PageRecord | undefined
  ): Promise<string> => {
    if (page) {
      return await readExpandedEntryText(project, page);
    }
    return route.sourcePath ? await readFile(route.sourcePath, "utf-8") : "";
  };

  return async (
    route: RouteManifestEntry,
    audience: VisibilityAudience
  ): Promise<{ format?: "md" | "mdx"; md: string; source: string }> => {
    const page = pageById.get(route.id);
    let text = await readRoute(route, page);
    if (route.sourcePath) {
      text = rewriteRelativeAssets({
        deployBase: project.config.deployment.options.base,
        frontMatterImages: page ? frontMatterImages(page) : [],
        projectRoot: project.context.root,
        source: text,
        sourcePath: route.sourcePath,
      });
    }
    // `./install` means the page's sibling, not whatever the `.md` URL an
    // agent fetched resolves it to, and `/install` gains the base and the
    // page's locale the rendered link has — remote content included.
    text = rewriteLinks(text, {
      entryId: page?.entryId,
      route: route.path,
      sourcePath: route.sourcePath,
    });
    const source = applyAudienceVisibility(text, audience);
    // The `.md` variant keeps the front-matter block in the output, but its
    // data must also be in scope for `prop={frontmatter.*}` expressions.
    const md = downlevelComponents(source, components, matter(source).data);
    return { format: page?.format, md, source };
  };
};

/** An MDX module statement: where it starts in the page, and its text. */
interface ModuleStatement {
  offset: number;
  text: string;
}

/**
 * An MDX page's module statements (`import`, `export`) as written, read off
 * its syntax tree so a statement over several lines is whole and fenced code
 * is left alone. None when the page doesn't parse as MDX.
 */
const moduleStatements = (source: string): ModuleStatement[] => {
  let tree: Nodes;
  try {
    tree = mdxToMdast(source, { features: MDX_FEATURES });
  } catch {
    return [];
  }
  return ("children" in tree ? tree.children : []).flatMap((node) => {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    return node.type === "mdxjsEsm" && from !== undefined && to !== undefined
      ? [{ offset: from, text: source.slice(from, to) }]
      : [];
  });
};

/**
 * `markdown` without `statements`: each where the parser found it in the
 * source the Markdown came from, when the Markdown still has it there (front
 * matter and module statements open a page, and downleveling leaves them be),
 * else where its text first appears. The last goes first, so the earlier
 * offsets still hold.
 */
const withoutStatements = (
  markdown: string,
  statements: ModuleStatement[]
): string => {
  let text = markdown;
  for (const { offset, text: statement } of statements.toReversed()) {
    const at = text.startsWith(statement, offset)
      ? offset
      : text.indexOf(statement);
    if (at !== -1) {
      text = text.slice(0, at) + text.slice(at + statement.length);
    }
  }
  return text;
};

/**
 * Map every route to its raw source Markdown. Powers the `<route>.md` and
 * `<route>.mdx` endpoints: `.mdx` serves the original source so tools can see
 * exactly what the author wrote, while `.md` downlevels supported components
 * to plain Markdown for consumers that can't interpret JSX. `<Visibility>`
 * audiences are resolved for agents in both variants: web-only content is
 * removed, agents-only unwrapped. Relative image references are rewritten to
 * their served `/blume-assets/content/…` URLs in both variants too — an agent
 * fetches these endpoints by URL, where a colocated `./diagram.png` resolves
 * to nothing — and relative page links to the routes they mean, as the
 * rendered page's are (see `relative-links.ts`).
 */
export const buildRawMarkdown = async (
  project: BlumeProject
): Promise<Record<string, RawMarkdownEntry>> => {
  const read = routeMarkdownReader(project);
  const entries = await Promise.all(
    project.manifest.routes.map(async (route) => {
      const { md, source } = await read(route, "agents");
      const entry: RawMarkdownEntry =
        md === source ? { mdx: source } : { md, mdx: source };
      return [route.path, entry] as const;
    })
  );
  const map = Object.fromEntries(entries);
  const userPages = project.context.pagesRoot
    ? await discoverPages(project.context.pagesRoot)
    : [];
  // A landing-page homepage (user `.astro` page, or no home route at all) has
  // no Markdown source, but agents negotiating `Accept: text/markdown` on `/`
  // still expect a Markdown answer. The llms.txt index — the machine-readable
  // representation of the site a landing page fronts — becomes its mirror, so
  // `/index.md` always exists (see `markdownRoutePaths`). Like llms.txt, it
  // leaves out an MCP server a page's route kept from being generated.
  if (!map["/"]) {
    map["/"] = {
      mdx: buildLlmsIndex({
        ...project,
        config: advertisedConfig(project.config, {
          mcp: servesMcp(project, userPages),
          // Skills are collected at the end of the build, after this runs.
          skills: servesSkillsIndex(project.config),
        }),
      }),
    };
  }
  // The generated changelog index has no source either; its release list is
  // its mirror, so `/changelog.md` and `get_page` answer as the page does.
  if (hasGeneratedChangelog(project, userPages)) {
    map[CHANGELOG_INDEX_ROUTE] = { mdx: buildChangelogIndexMarkdown(project) };
  }
  // Likewise the generated blog index: its post list is `/blog.md`.
  if (hasGeneratedBlog(project, userPages)) {
    map[BLOG_INDEX_ROUTE] = { mdx: buildBlogIndexMarkdown(project) };
  }
  return map;
};

/**
 * The pages a feed carries whole (`seo.rss.content`), as Markdown for human
 * readers — the `.md` mirror's pipeline with `<Visibility>` resolved for the
 * web — by route. Empty unless `seo.rss.content` is on, and only the pages
 * within each feed's limit are read.
 */
export const buildFeedMarkdown = async (
  project: BlumeProject
): Promise<Record<string, string>> => {
  const { rss } = project.config.seo;
  if (!rss.content) {
    return {};
  }
  const read = routeMarkdownReader(project);
  const carried = feedRoutes(project);
  const routes = project.manifest.routes.filter(
    (route) =>
      !(route.fallback || route.draft || route.hidden) &&
      carried.has(route.path)
  );
  return Object.fromEntries(
    await Promise.all(
      routes.map(async (route) => {
        const { format, md, source } = await read(route, "web");
        // An MDX page's module statements and comments, which the
        // downleveled Markdown keeps as written, are code no reader is shown.
        const body =
          format === "mdx"
            ? withoutJsxComments(
                withoutStatements(md, moduleStatements(source))
              )
            : md;
        return [route.path, body] as const;
      })
    )
  );
};

/**
 * Every route path with a raw-Markdown mirror: the manifest routes, plus the
 * homepage when its mirror is the synthesized llms.txt fallback and the
 * generated changelog and blog indexes (see `buildRawMarkdown`). This is the route list the negotiation surfaces (dev
 * middleware, Vercel routing config) and the homepage `Link` header build
 * from, so `Accept: text/markdown` on `/` resolves even when the homepage is
 * a landing page.
 */
export const markdownRoutePaths = (project: BlumeProject): string[] => {
  const paths = project.manifest.routes.map((route) => route.path);
  if (!paths.includes("/")) {
    paths.push("/");
  }
  const userPages = project.context.pagesRoot
    ? discoverPagesSync(project.context.pagesRoot)
    : [];
  if (hasGeneratedChangelog(project, userPages)) {
    paths.push(CHANGELOG_INDEX_ROUTE);
  }
  if (hasGeneratedBlog(project, userPages)) {
    paths.push(BLOG_INDEX_ROUTE);
  }
  return paths;
};

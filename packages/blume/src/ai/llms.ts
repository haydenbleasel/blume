import { normalizeBasePath, withBasePath } from "../core/base-path.ts";
import { rewriteRelativeImages } from "../core/content-assets.ts";
import matter from "../core/frontmatter.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { absoluteUrl } from "../core/site-url.ts";
import { readExpandedEntryText } from "../core/sources/read.ts";
import type { NavNode, Navigation, PageRecord } from "../core/types.ts";
import { buildRssFeeds } from "../deploy/rss.ts";
import {
  downlevelComponents,
  exampleComponentSerializers,
} from "./component-markdown.ts";
import { applyAgentVisibility } from "./visibility.ts";

// Routes carry `basePath`; a `deployment.base` subdirectory is layered on top —
// with or without a `site` (the mcp.json convention) — so the emitted URL
// matches where the page is served. Encoded like the sitemap: a route with
// spaces or non-ASCII must still yield a valid Markdown link.
const pageUrl = (route: string, site?: string, base = ""): string => {
  const path = withBasePath(base, route);
  return encodeURI(site ? absoluteUrl(site, path) : path);
};

// Drafts, hidden, and ordinary `noindex` pages are excluded. Generated API
// references keep crawler visibility (`noindex`) separate from LLM visibility
// (`ai.exclude`), and are excluded wholesale when `ai.llmsTxt.openapi` is off.
// `versions: "current"` additionally drops archived-snapshot pages — the flat
// llms-full.txt dump serves agents the live docs, not every frozen copy.
const eligiblePages = (
  project: BlumeProject,
  options: { versions?: "all" | "current" } = {}
): PageRecord[] =>
  project.graph.pages.filter(
    (page) =>
      !(
        page.meta.ai.exclude ||
        page.meta.draft ||
        page.meta.sidebar.hidden ||
        (page.meta.seo.noindex && page.source.name !== "openapi") ||
        (options.versions === "current" && page.version !== "")
      ) &&
      (project.config.ai.llmsTxt.openapi || page.source.name !== "openapi")
  );

/**
 * The navigation trees the index mirrors: the site tree, or one per locale
 * under i18n (each labeled with the locale except the default, so sections
 * don't repeat ambiguously). On a versioned site each archived snapshot's
 * trees follow the current ones, labeled with the version (and locale) so an
 * agent reading the index knows which docs are frozen.
 */
const indexedNavigations = (
  project: BlumeProject
): { label?: string; nav: Navigation }[] => {
  const { i18n, versions } = project.config;
  const current: { label?: string; nav: Navigation }[] = i18n
    ? i18n.locales.flatMap(({ code, label }) => {
        const nav = project.graph.navigationByLocale[code];
        if (!nav) {
          return [];
        }
        return [
          { label: code === i18n.defaultLocale ? undefined : label, nav },
        ];
      })
    : [{ nav: project.graph.navigation }];

  const archived = (versions?.archived ?? []).flatMap((version) => {
    const byLocale = project.graph.navigationByVersion[version.id] ?? {};
    const versionLabel = `${version.label ?? version.id} (archived)`;
    return Object.entries(byLocale).flatMap(([code, nav]) => {
      const locale = i18n?.locales.find((entry) => entry.code === code);
      const label =
        locale && code !== i18n?.defaultLocale
          ? `${locale.label} — ${versionLabel}`
          : versionLabel;
      return [{ label, nav }];
    });
  });

  return [...current, ...archived];
};

/**
 * Build the compact `llms.txt` index: title and summary, then the sidebar tree
 * rendered as sections — group labels become headings, pages become link lists —
 * so the file mirrors how the docs are organized rather than one flat blob.
 * Also serves as the homepage's synthesized Markdown mirror when the home
 * route is a landing page (see `buildRawMarkdown`).
 */
export const buildLlmsIndex = (project: BlumeProject): string => {
  const { config } = project;
  const { site } = config.deployment;
  const base = normalizeBasePath(config.deployment.base);
  const eligible = eligiblePages(project);
  const byRoute = new Map(eligible.map((page) => [page.route, page]));
  const seen = new Set<string>();

  const line = (page: PageRecord): string => {
    seen.add(page.route);
    const summary = page.description ? `: ${page.description}` : "";
    return `- [${page.title}](${pageUrl(page.route, site, base)})${summary}`;
  };

  // One nav level -> Markdown blocks: the level's loose pages as a link list,
  // then each group as a heading (depth-capped at h6) followed by its own
  // blocks. Nav entries whose route has no eligible page — external links,
  // padded i18n fallbacks, `noindex` pages, excluded API references — are
  // skipped, and a group left with nothing emits no heading at all.
  const renderLevel = (nodes: NavNode[], depth: number): string[] => {
    const list: string[] = [];
    const groupBlocks: string[] = [];
    for (const node of nodes) {
      if (node.kind === "page") {
        const page = byRoute.get(node.route);
        if (page && !seen.has(page.route)) {
          list.push(line(page));
        }
        continue;
      }
      // An explicit-config group may link its index page on the group itself
      // (`root`) rather than as a child; keep it at the top of the section.
      const rootPage = node.route ? byRoute.get(node.route) : undefined;
      const blocks = renderLevel(node.children, depth + 1);
      if (rootPage && !seen.has(rootPage.route)) {
        blocks.unshift(line(rootPage));
      }
      if (blocks.length > 0) {
        groupBlocks.push(
          `${"#".repeat(Math.min(depth, 6))} ${node.label}`,
          ...blocks
        );
      }
    }
    return list.length > 0 ? [list.join("\n"), ...groupBlocks] : groupBlocks;
  };

  // Loose pages at a tree's root get a "Docs" section of their own, so every
  // link sits under an h2 as llms.txt consumers expect.
  const renderNav = (nav: Navigation, depth: number): string[] => {
    const loose = nav.sidebar.filter((node) => node.kind === "page");
    const groups = nav.sidebar.filter((node) => node.kind === "group");
    const looseBlocks = renderLevel(loose, depth + 1);
    return [
      ...(looseBlocks.length > 0
        ? [`${"#".repeat(depth)} Docs`, ...looseBlocks]
        : []),
      ...renderLevel(groups, depth),
    ];
  };

  const blocks: string[] = [];
  for (const { label, nav } of indexedNavigations(project)) {
    if (label) {
      const localized = renderNav(nav, 3);
      if (localized.length > 0) {
        blocks.push(`## ${label}`, ...localized);
      }
      continue;
    }
    blocks.push(...renderNav(nav, 2));
  }

  // Pages the navigation doesn't reach (an explicit sidebar that omits them,
  // or a hand-rolled tree) still belong in the index.
  const leftover = eligible
    .filter((page) => !seen.has(page.route))
    .toSorted((a, b) => a.route.localeCompare(b.route));
  if (leftover.length > 0) {
    blocks.push(
      blocks.length > 0 ? "## Other" : "## Docs",
      leftover.map(line).join("\n")
    );
  }

  // Surface the RSS feeds so agents can find fresh content (new blog posts,
  // changelog entries) without re-crawling the index. `buildRssFeeds` is empty
  // unless RSS is enabled and an absolute `site` is set — the same condition
  // under which agent-readability.json lists `artifacts.feeds`.
  const feeds = buildRssFeeds(project);
  if (feeds.length > 0) {
    blocks.push(
      "## RSS Feeds",
      feeds
        .map((feed) => `- [${feed.title}](${pageUrl(feed.path, site, base)})`)
        .join("\n")
    );
  }

  const header = config.description
    ? `# ${config.title}\n\n> ${config.description}`
    : `# ${config.title}`;
  return `${[header, ...blocks].join("\n\n")}\n`;
};

/** Build `llms-full.txt`: the full Markdown body of every current-docs page. */
const buildFull = async (project: BlumeProject): Promise<string> => {
  const { config } = project;
  const pages = eligiblePages(project, { versions: "current" }).toSorted(
    (a, b) => a.route.localeCompare(b.route)
  );
  // Downlevel `<Component>` to its example's source; a same-name user
  // `markdownComponents` entry is spread last and still wins.
  const components = {
    ...exampleComponentSerializers(project.examples ?? {}),
    ...config.ai.markdownComponents,
  };

  const sections = await Promise.all(
    pages.map(async (page) => {
      let raw = await readExpandedEntryText(project, page);
      // Colocated `./image.png` references resolve to nothing for a reader of
      // llms-full.txt; point them at the served originals instead.
      if (page.sourcePath) {
        raw = rewriteRelativeImages({
          deployBase: config.deployment.base,
          projectRoot: project.context.root,
          source: raw,
          sourcePath: page.sourcePath,
        });
      }
      // Resolve `<Visibility>` audiences (web-only content omitted from the
      // agent-facing output, agents-only unwrapped), then downlevel supported
      // components to plain Markdown.
      const parsed = matter(raw);
      const body = downlevelComponents(
        applyAgentVisibility(parsed.content),
        components,
        parsed.data
      ).trim();
      const url = pageUrl(
        page.route,
        config.deployment.site,
        normalizeBasePath(config.deployment.base)
      );
      return [`# ${page.title}`, `Source: ${url}`, "", body].join("\n");
    })
  );

  const header = config.description
    ? `# ${config.title}\n\n> ${config.description}\n`
    : `# ${config.title}\n`;

  return `${header}\n${sections.join("\n\n---\n\n")}\n`;
};

/** Build both LLM text artifacts for a project. */
export const buildLlmsFiles = async (
  project: BlumeProject
): Promise<{ index: string; full: string }> => ({
  full: await buildFull(project),
  index: buildLlmsIndex(project),
});

import { normalizeBasePath, withBasePath } from "../core/base-path.ts";
import matter from "../core/frontmatter.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { readEntryText } from "../core/sources/read.ts";
import type { NavNode, Navigation, PageRecord } from "../core/types.ts";
import { downlevelComponents } from "./component-markdown.ts";
import { applyAgentVisibility } from "./visibility.ts";

// Routes carry `basePath`; a `deployment.base` subdirectory is layered on top —
// with or without a `site` (the mcp.json convention) — so the emitted URL
// matches where the page is served. Encoded like the sitemap: a route with
// spaces or non-ASCII must still yield a valid Markdown link.
const pageUrl = (route: string, site?: string, base = ""): string => {
  const path = withBasePath(base, route);
  return encodeURI(site ? `${site.replace(/\/$/u, "")}${path}` : path);
};

// Drafts, hidden, and `noindex` pages are excluded, matching the sitemap.
// Generated API reference pages are excluded when `ai.llmsTxt.openapi` is off
// (they arrive through the internal staged "openapi" source).
const eligiblePages = (project: BlumeProject): PageRecord[] =>
  project.graph.pages.filter(
    (page) =>
      !(page.meta.draft || page.meta.sidebar.hidden || page.meta.seo.noindex) &&
      (project.config.ai.llmsTxt.openapi || page.source.name !== "openapi")
  );

/**
 * The navigation trees the index mirrors: the site tree, or one per locale
 * under i18n (each labeled with the locale except the default, so sections
 * don't repeat ambiguously).
 */
const indexedNavigations = (
  project: BlumeProject
): { label?: string; nav: Navigation }[] => {
  const { i18n } = project.config;
  if (i18n) {
    return i18n.locales.flatMap(({ code, label }) => {
      const nav = project.graph.navigationByLocale[code];
      if (!nav) {
        return [];
      }
      return [{ label: code === i18n.defaultLocale ? undefined : label, nav }];
    });
  }
  return [{ nav: project.graph.navigation }];
};

/**
 * Build the compact `llms.txt` index: title and summary, then the sidebar tree
 * rendered as sections — group labels become headings, pages become link lists —
 * so the file mirrors how the docs are organized rather than one flat blob.
 */
const buildIndex = (project: BlumeProject): string => {
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

  const header = config.description
    ? `# ${config.title}\n\n> ${config.description}`
    : `# ${config.title}`;
  return `${[header, ...blocks].join("\n\n")}\n`;
};

/** Build `llms-full.txt`: the full Markdown body of every page. */
const buildFull = async (project: BlumeProject): Promise<string> => {
  const { config } = project;
  const pages = eligiblePages(project).toSorted((a, b) =>
    a.route.localeCompare(b.route)
  );

  const sections = await Promise.all(
    pages.map(async (page) => {
      const raw = await readEntryText(project, page);
      // Resolve `<Visibility>` audiences (web-only content omitted from the
      // agent-facing output, agents-only unwrapped), then downlevel supported
      // components to plain Markdown.
      const body = downlevelComponents(
        applyAgentVisibility(matter(raw).content),
        config.ai.markdownComponents
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
  index: buildIndex(project),
});

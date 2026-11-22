import { normalizeBasePath } from "../core/base-path.ts";
import { nonBlank } from "../core/blog.ts";
import { rewriteRelativeAssets } from "../core/content-assets.ts";
import matter from "../core/frontmatter.ts";
import { isHiddenPage } from "../core/hidden-pages.ts";
import { metaDescription } from "../core/manifest.ts";
import { isRootTab, isUnderPath } from "../core/navigation.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { extractHeadings } from "../core/sources/normalize.ts";
import { readExpandedEntryText } from "../core/sources/read.ts";
import type { NavNode, NavTab, Navigation, PageRecord } from "../core/types.ts";
import { buildRssFeeds } from "../deploy/rss.ts";
import { AI_CATALOG_PATH, hasAiCatalog } from "./ai-catalog.ts";
import { API_CATALOG_PATH, hasApiCatalog } from "./api-catalog.ts";
import { API_PAGES_PATH, OPENAPI_PATH } from "./api/paths.ts";
import type { BuiltAgentPage } from "./built-pages.ts";
import { downlevelComponents } from "./component-markdown.ts";
import { linkText, pageUrl } from "./link-text.ts";
import { relativeLinkRewriter } from "./relative-links.ts";
import { projectComponentSerializers } from "./serializers.ts";
import {
  AGENT_SKILLS_DIR,
  AGENT_SKILLS_INDEX_PATH,
  servesSkillsIndex,
} from "./skills.ts";
import type { SkillArtifact } from "./skills.ts";
import { applyAgentVisibility } from "./visibility.ts";

/**
 * Inputs only the build has: the published skills, collected once per build,
 * and the custom pages read back from the built HTML.
 */
export interface LlmsIndexOptions {
  /**
   * Custom `.astro` pages that join the agent surfaces (see
   * `ai/built-pages.ts`), listed under the navigation tab whose section they
   * sit in. Absent (empty) for the homepage Markdown mirror, which is
   * synthesized before the pages are built.
   */
  pages?: readonly BuiltAgentPage[];
  /**
   * The Agent Skills the build publishes under `/.well-known/agent-skills/`,
   * listed in their own section with each skill's description — which is
   * where a skill says when to use it. Absent (empty) for the homepage
   * Markdown mirror, which is synthesized before the skills are collected.
   */
  skills?: readonly SkillArtifact[];
}

/** The heading for custom pages that sit under no section tab. */
const PAGES_SECTION = "Pages";

/**
 * The position of the tab whose section holds `route` (the longest matching
 * tab path), or one past the last tab when none does — so sections sort in
 * the order the header shows its tabs, and ones outside every tab go last.
 */
const tabRank = (
  tabs: readonly NavTab[],
  route: string | undefined
): number => {
  let rank = tabs.length;
  let length = -1;
  if (route === undefined) {
    return rank;
  }
  for (const [index, { path }] of tabs.entries()) {
    if (isUnderPath(route, path) && path.length > length) {
      rank = index;
      ({ length } = path);
    }
  }
  return rank;
};

/** A route that places a sidebar group: its folder, its link, or its first page. */
const groupRoute = (node: NavNode): string | undefined => {
  if (node.kind === "page") {
    return node.route;
  }
  return (
    node.path ??
    node.route ??
    node.children.map(groupRoute).find((route) => route !== undefined)
  );
};

/**
 * The section tab a custom page sits under: the most specific tab whose path
 * prefixes its route, other than the tree's root tab (a page under no section
 * gets the generic section rather than the docs' own).
 */
const sectionTab = (nav: Navigation, route: string): NavTab | undefined => {
  let match: NavTab | undefined;
  for (const tab of nav.tabs) {
    if (
      isUnderPath(route, tab.path) &&
      !isRootTab(tab, nav.root ?? "/") &&
      (!match || tab.path.length > match.path.length)
    ) {
      match = tab;
    }
  }
  return match;
};

/** A skill description on one line — SKILL.md frontmatter may wrap it. */
const oneLine = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

/**
 * The "Agent resources" section: every machine-readable artifact the site
 * publishes, so an agent that only reads llms.txt still finds the full
 * Markdown dump, the per-page Markdown mirrors, the JSON docs API, the MCP
 * server, the skills index, the API catalog, the readability manifest, and
 * the sitemap. The
 * same artifact set `agent-readability.json` indexes, in prose an agent can
 * act on without a second fetch.
 */
const agentResourceLines = (project: BlumeProject): string[] => {
  const { config } = project;
  const { site } = config.deployment.options;
  const url = (path: string): string =>
    pageUrl(path, site, normalizeBasePath(config.deployment.options.base));
  const lines = [
    `- [llms-full.txt](${url("/llms-full.txt")}): The full Markdown of every page in one file.`,
    `- [Page Markdown](${url("/index.md")}): Append \`.md\` to any page URL to fetch that page as raw Markdown.`,
  ];
  if (config.agents.api) {
    lines.push(
      `- [JSON API](${url(API_PAGES_PATH)}): Page index of the JSON docs API; each entry links the page's JSON and Markdown forms. Described by the OpenAPI document at ${url(OPENAPI_PATH)}.`
    );
  }
  if (config.agents.mcp.enabled) {
    lines.push(
      `- [MCP server](${url(config.agents.mcp.route)}): Streamable HTTP Model Context Protocol server with search_docs, get_page, list_pages, and get_navigation tools, plus every page as a resource. Discovery document: ${url("/.well-known/mcp.json")}`
    );
  }
  if (servesSkillsIndex(config)) {
    lines.push(
      `- [Agent skills](${url(AGENT_SKILLS_INDEX_PATH)}): Agent Skills discovery index of the skills this site publishes.`
    );
  }
  if (hasApiCatalog(config)) {
    lines.push(
      `- [API catalog](${url(API_CATALOG_PATH)}): RFC 9727 linkset of the APIs documented here.`
    );
  }
  if (hasAiCatalog(config)) {
    lines.push(
      `- [AI catalog](${url(AI_CATALOG_PATH)}): ARD manifest of the agent-facing resources on this site (MCP server, skills, APIs).`
    );
  }
  if (config.agents.agentReadability) {
    lines.push(
      `- [agent-readability.json](${url("/agent-readability.json")}): Manifest of every agent-facing artifact on this site.`
    );
  }
  if (site && config.seo.sitemap) {
    lines.push(
      `- [Sitemap](${url("/sitemap.xml")}): Every indexable page URL with its last-modified date.`
    );
  }
  return lines;
};

// Drafts, hidden, and ordinary `noindex` pages are excluded. Generated API
// references keep crawler visibility (`noindex`) separate from LLM visibility
// (`ai.exclude`), and are excluded wholesale when `agents.llmsTxt.openapi` is off.
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
        isHiddenPage(page, project.graph) ||
        (page.meta.seo.noindex && page.source.name !== "openapi") ||
        (options.versions === "current" && page.version !== "")
      ) &&
      (project.config.agents.llmsTxt.openapi || page.source.name !== "openapi")
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

/** A rendered `llms.txt` index and the order its page links appear in. */
interface RenderedIndex {
  /** Every linked route, in the order the index lists it. */
  order: string[];
  text: string;
}

/** A section of the index, placed by the tab it sits under. */
interface IndexSection {
  rank: number;
  render: () => string[];
}

/** A root node listed with the loose pages: a page, or a year of entries. */
const isLoose = (node: NavNode): boolean =>
  node.kind === "page" || Boolean(node.period);

/**
 * Build the compact `llms.txt` index: title and summary, then the sidebar tree
 * rendered as sections — group labels become headings, pages become link lists —
 * so the file mirrors how the docs are organized rather than one flat blob.
 * Top-level sections follow the order of the header's tabs, and custom pages
 * read back from the build join the tab whose section they sit in. Also
 * serves as the homepage's synthesized Markdown mirror when the home route is
 * a landing page (see `buildRawMarkdown`).
 */
const renderLlmsIndex = (
  project: BlumeProject,
  options: LlmsIndexOptions
): RenderedIndex => {
  const { config } = project;
  const { site } = config.deployment.options;
  const base = normalizeBasePath(config.deployment.options.base);
  const eligible = eligiblePages(project);
  const byRoute = new Map(eligible.map((page) => [page.route, page]));
  const seen = new Set<string>();
  const order: string[] = [];
  const customPages = options.pages ?? [];
  const customSeen = new Set<string>();

  const line = (page: PageRecord): string => {
    seen.add(page.route);
    order.push(page.route);
    // The page's meta description, so a page summarized only in
    // `seo.description` (a generated reference page) still gets one, and a
    // blog post without either its first paragraph.
    const description = nonBlank(metaDescription(page)) ?? page.post?.excerpt;
    const summary = description ? `: ${description}` : "";
    return `- [${linkText(page.title)}](${pageUrl(page.route, site, base)})${summary}`;
  };

  const customLine = (page: BuiltAgentPage): string => {
    customSeen.add(page.route);
    order.push(page.route);
    const { description, title } = page.document;
    const summary = description ? `: ${description}` : "";
    return `- [${linkText(title)}](${pageUrl(page.route, site, base)})${summary}`;
  };

  // A tab's custom pages: the tab's own page first, then by route.
  const customSection = (
    label: string,
    pages: BuiltAgentPage[],
    path: string | undefined,
    depth: number
  ): string[] => [
    `${"#".repeat(depth)} ${label}`,
    pages
      .toSorted(
        (a, b) =>
          Number(b.route === path) - Number(a.route === path) ||
          a.route.localeCompare(b.route)
      )
      .map(customLine)
      .join("\n"),
  ];

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
      // A year group of dated entries is no section: its posts list under
      // the heading of the section around it, newest first.
      if (node.period) {
        for (const child of node.children) {
          const page = child.kind === "page" && byRoute.get(child.route);
          if (page && !seen.has(page.route)) {
            list.push(line(page));
          }
        }
        continue;
      }
      // An explicit-config group may link its index page on the group itself
      // (`root`) rather than as a child; keep it at the top of the section.
      const rootPage = node.route ? byRoute.get(node.route) : undefined;
      const rootLine =
        rootPage && !seen.has(rootPage.route) ? line(rootPage) : null;
      const blocks = renderLevel(node.children, depth + 1);
      if (rootLine) {
        blocks.unshift(rootLine);
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
  // link sits under an h2 as llms.txt consumers expect. The groups, and the
  // custom pages when this is the site's own tree, follow in tab order.
  const renderNav = (
    nav: Navigation,
    depth: number,
    withCustomPages: boolean
  ): string[] => {
    const loose = nav.sidebar.filter(isLoose);
    const looseBlocks = renderLevel(loose, depth + 1);
    const sections: IndexSection[] = nav.sidebar
      .filter((node) => !isLoose(node))
      .map((group) => ({
        rank: tabRank(nav.tabs, groupRoute(group)),
        render: () => renderLevel([group], depth),
      }));
    if (withCustomPages) {
      const byTab = new Map<NavTab | undefined, BuiltAgentPage[]>();
      for (const page of customPages) {
        const tab = sectionTab(nav, page.route);
        byTab.set(tab, [...(byTab.get(tab) ?? []), page]);
      }
      for (const [tab, pages] of byTab) {
        sections.push({
          rank: tab ? nav.tabs.indexOf(tab) : nav.tabs.length,
          render: () =>
            customSection(tab?.label ?? PAGES_SECTION, pages, tab?.path, depth),
        });
      }
    }
    return [
      ...(looseBlocks.length > 0
        ? [`${"#".repeat(depth)} Docs`, ...looseBlocks]
        : []),
      ...sections
        .toSorted((a, b) => a.rank - b.rank)
        .flatMap((section) => section.render()),
    ];
  };

  const blocks: string[] = [];
  for (const { label, nav } of indexedNavigations(project)) {
    if (label) {
      const localized = renderNav(nav, 3, false);
      if (localized.length > 0) {
        blocks.push(`## ${label}`, ...localized);
      }
      continue;
    }
    blocks.push(...renderNav(nav, 2, true));
  }

  // Custom pages no tree took (a locale tree missing its navigation) keep a
  // section of their own.
  const unplaced = customPages.filter((page) => !customSeen.has(page.route));
  if (unplaced.length > 0) {
    blocks.push(...customSection(PAGES_SECTION, unplaced, undefined, 2));
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
        .map(
          (feed) =>
            `- [${linkText(feed.title)}](${pageUrl(feed.path, site, base)})`
        )
        .join("\n")
    );
  }

  // The published skills, each with its description — the one place a skill
  // states when an agent should reach for it.
  const skills = options.skills ?? [];
  if (skills.length > 0) {
    blocks.push(
      "## Agent skills",
      skills
        .map(
          (skill) =>
            `- [${skill.name}](${pageUrl(`${AGENT_SKILLS_DIR}/${skill.path}`, site, base)}): ${oneLine(skill.description)}`
        )
        .join("\n")
    );
  }

  blocks.push("## Agent resources", agentResourceLines(project).join("\n"));

  const header = config.description
    ? `# ${config.title}\n\n> ${config.description}`
    : `# ${config.title}`;
  // `details` is the llms.txt spec's free-form block between the summary and
  // the file sections — "when to use this" guidance in the site's own words.
  const { details } = config.agents.llmsTxt;
  const lead = details ? `${header}\n\n${details}` : header;
  return { order, text: `${[lead, ...blocks].join("\n\n")}\n` };
};

/** The `llms.txt` index (see {@link renderLlmsIndex}). */
export const buildLlmsIndex = (
  project: BlumeProject,
  options: LlmsIndexOptions = {}
): string => renderLlmsIndex(project, options).text;

// A line an ATX heading opens (`# Title`); any other first line can only open
// a setext heading, underlined on the line after it.
const ATX_HEADING = /^ {0,3}#/u;

/**
 * A page body without the `# Heading` it opens with, when that heading's text
 * is the page's title. An untitled page takes its title from that heading,
 * and its `llms-full.txt` section already opens with `# <title>`, so the
 * heading would show twice; the rendered page drops it the same way (see
 * `markdown/title-heading.ts`).
 */
const withoutTitleHeading = (body: string, title: string): string => {
  const lines = body.split("\n");
  const span = ATX_HEADING.test(lines[0] ?? "") ? 1 : 2;
  const [heading] = extractHeadings(lines.slice(0, span).join("\n"));
  return heading?.depth === 1 && heading.text === title
    ? lines.slice(span).join("\n").trimStart()
    : body;
};

/** A page's `llms-full.txt` section: its title, its URL, then its body. */
const fullSection = (title: string, url: string, body: string): string =>
  [`# ${title}`, `Source: ${url}`, "", withoutTitleHeading(body, title)].join(
    "\n"
  );

/**
 * Build `llms-full.txt`: the full Markdown body of every current-docs page,
 * and of every custom page read back from the build, in the order the index
 * lists them (`order`): it links every page this file holds.
 */
const buildFull = async (
  project: BlumeProject,
  customPages: readonly BuiltAgentPage[],
  order: readonly string[]
): Promise<string> => {
  const { config } = project;
  const url = (route: string): string =>
    pageUrl(
      route,
      config.deployment.options.site,
      normalizeBasePath(config.deployment.options.base)
    );
  const position = new Map(order.map((route, index) => [route, index]));
  const components = projectComponentSerializers(project);
  const rewriteLinks = relativeLinkRewriter(project);

  const contentSection = async (page: PageRecord): Promise<string> => {
    let raw = await readExpandedEntryText(project, page);
    // Colocated `./image.png` references resolve to nothing for a reader of
    // llms-full.txt; point them at the served originals instead.
    if (page.sourcePath) {
      raw = rewriteRelativeAssets({
        deployBase: config.deployment.options.base,
        format: page.format,
        projectRoot: project.context.root,
        source: raw,
        sourcePath: page.sourcePath,
      });
    }
    // Page links too: a reader of one flat file has no page URL to resolve
    // `./install` against, and `/install` needs the base the site is
    // served under.
    raw = rewriteLinks(raw, page);
    // Resolve `<Visibility>` audiences (web-only content omitted from the
    // agent-facing output, agents-only unwrapped), then downlevel supported
    // components to plain Markdown.
    const parsed = matter(raw);
    const body = downlevelComponents(
      applyAgentVisibility(parsed.content),
      components,
      parsed.data
    ).trim();
    return fullSection(page.title, url(page.route), body);
  };

  const entries = [
    ...eligiblePages(project, { versions: "current" }).map((page) => ({
      render: (): Promise<string> | string => contentSection(page),
      route: page.route,
    })),
    ...customPages.map((page) => ({
      render: () =>
        fullSection(
          page.document.title,
          url(page.route),
          page.document.markdown
        ),
      route: page.route,
    })),
  ].toSorted(
    (a, b) => (position.get(a.route) ?? 0) - (position.get(b.route) ?? 0)
  );
  const sections = await Promise.all(entries.map((entry) => entry.render()));

  const header = config.description
    ? `# ${config.title}\n\n> ${config.description}\n`
    : `# ${config.title}\n`;

  return `${header}\n${sections.join("\n\n---\n\n")}\n`;
};

/** Build both LLM text artifacts for a project. */
export const buildLlmsFiles = async (
  project: BlumeProject,
  options: LlmsIndexOptions = {}
): Promise<{ index: string; full: string }> => {
  const index = renderLlmsIndex(project, options);
  return {
    full: await buildFull(project, options.pages ?? [], index.order),
    index: index.text,
  };
};

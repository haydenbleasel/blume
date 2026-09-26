import { hasGeneratedChangelog } from "../astro/pages.ts";
import {
  mountBasePath,
  normalizeBasePath,
  withBasePath,
} from "../core/base-path.ts";
import { CHANGELOG_INDEX_ROUTE } from "../core/changelog-index.ts";
import { discoverPagesSync } from "../core/custom-pages.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { absoluteUrl } from "../core/site-url.ts";
import type { NavNode, PageRecord } from "../core/types.ts";
import { resolveReferences } from "../openapi/references.ts";
import { docsPhrase } from "./ai-catalog.ts";
import { API_PAGES_PATH } from "./api/paths.ts";
import { asciiSlugify } from "./mcp/discovery.ts";
import {
  SKILL_DESCRIPTION_MAX,
  generatesSiteSkill,
  skillMdArtifact,
} from "./skills.ts";
import type { SkillArtifact } from "./skills.ts";

/**
 * The site's own agent skill (`agents.skillMd`): a `SKILL.md` in the Agent
 * Skills format, built from what the build already knows — the site's title
 * and description, how to read any page as Markdown, llms.txt and the MCP
 * server, the API references, and a map of the docs with each page's one-line
 * description. No model writes it, so it costs nothing and is current with
 * every build: a guide to the docs rather than a summary of the product. A
 * hand-written skill of the same name in `agents.skills` replaces it.
 */

/** The most pages the map lists; llms.txt holds the rest. */
export const MAX_SKILL_PAGES = 200;

/** The Agent Skills spec caps a skill name at 64 characters. */
const NAME_MAX = 64;

/** Where the site skill is served besides the discovery index. */
export const SKILL_MD_PATH = "/skill.md";

/**
 * The site skill's name: the title as a skill name (lowercase alphanumerics
 * and single hyphens), else the site's host, for a title with no Latin
 * letters in it.
 */
export const siteSkillName = (project: BlumeProject): string => {
  const { site } = project.config.deployment.options;
  const fromTitle = asciiSlugify(project.config.title);
  const name =
    fromTitle || asciiSlugify(site ? new URL(site).hostname : "") || "docs";
  return name.slice(0, NAME_MAX).replace(/-+$/u, "");
};

/** A title as Markdown link text (brackets escaped, as in llms.txt). */
const linkText = (title: string): string =>
  title.replaceAll(/[\\[\]]/gu, String.raw`\$&`);

/**
 * Current-version, default-locale pages worth listing: not API operations,
 * and not changelog entries, which the changelog index covers in one line.
 */
const mappedPages = (project: BlumeProject): PageRecord[] => {
  const defaultLocale = project.config.i18n?.defaultLocale;
  return project.graph.pages.filter(
    (page) =>
      !(
        page.meta.ai.exclude ||
        page.meta.draft ||
        page.meta.sidebar.hidden ||
        page.meta.seo.noindex ||
        page.version !== "" ||
        page.source.name === "openapi" ||
        page.contentType === "changelog"
      ) &&
      (defaultLocale === undefined || page.locale === defaultLocale)
  );
};

/** Renders the page map, listing each page once, up to the cap. */
class PageMap {
  readonly #byRoute: Map<string, PageRecord>;
  readonly #listed = new Set<string>();
  readonly #url: (route: string) => string;

  constructor(pages: PageRecord[], url: (route: string) => string) {
    this.#byRoute = new Map(pages.map((page) => [page.route, page]));
    this.#url = url;
  }

  /** How many listable pages the cap left out. */
  get omitted(): number {
    return this.#byRoute.size - this.#listed.size;
  }

  /** The Markdown link line for a route, or nothing when it isn't listed. */
  line(route: string): string[] {
    const page = this.#byRoute.get(route);
    if (
      !page ||
      this.#listed.has(route) ||
      this.#listed.size >= MAX_SKILL_PAGES
    ) {
      return [];
    }
    this.#listed.add(route);
    const summary = page.description ? `: ${page.description}` : "";
    return [`- [${linkText(page.title)}](${this.#url(route)})${summary}`];
  }

  /** One navigation level: its loose pages, then each group under a heading. */
  level(nodes: NavNode[], depth: number): string[] {
    const list: string[] = [];
    const groups: string[] = [];
    for (const node of nodes) {
      if (node.kind === "page") {
        list.push(...this.line(node.route));
        continue;
      }
      const blocks = [
        ...(node.route ? this.line(node.route) : []),
        ...this.level(node.children, depth + 1),
      ];
      if (blocks.length > 0) {
        groups.push(
          "",
          `${"#".repeat(Math.min(depth, 6))} ${node.label}`,
          "",
          ...blocks
        );
      }
    }
    return [...list, ...groups];
  }

  /** Pages the navigation doesn't reach, in route order. */
  rest(): string[] {
    return [...this.#byRoute.keys()]
      .toSorted((a, b) => a.localeCompare(b))
      .flatMap((route) => this.line(route));
  }
}

/** The "Reading the docs" bullets: every agent surface the site serves. */
const surfaceLines = (
  project: BlumeProject,
  url: (path: string) => string
): string[] => {
  const { agents } = project.config;
  const lines = [
    `- Any page as Markdown: add \`.md\` to its URL (the home page is ${url("/index.md")}). Every page link below already points at the Markdown.`,
  ];
  if (agents.llmsTxt.enabled) {
    lines.push(
      `- [llms.txt](${url("/llms.txt")}): every page with a one-line summary.`,
      `- [llms-full.txt](${url("/llms-full.txt")}): every page in one file, for when you need all of it.`
    );
  }
  if (agents.mcp.enabled) {
    lines.push(
      `- MCP server at ${url(agents.mcp.route)}, with \`search_docs\`, \`get_page\`, \`list_pages\`, and \`get_navigation\`. Connect it to search the docs instead of guessing URLs.`
    );
  }
  if (agents.api) {
    lines.push(
      `- [JSON API](${url(API_PAGES_PATH)}): the page index, with each page as JSON and Markdown.`
    );
  }
  const userPages = project.context.pagesRoot
    ? discoverPagesSync(project.context.pagesRoot)
    : [];
  if (hasGeneratedChangelog(project, userPages)) {
    lines.push(
      `- [Changelog](${url(`${CHANGELOG_INDEX_ROUTE}.md`)}): release notes, newest first.`
    );
  }
  return lines;
};

/** The "API reference" bullets, one per rendered reference. */
const referenceLines = (
  project: BlumeProject,
  url: (path: string) => string
): string[] =>
  resolveReferences(project.config).map((reference) => {
    // Scalar renders its own page with no Markdown mirror; Blume-rendered
    // references are pages like any other, one per operation.
    const route =
      reference.kind === "scalar"
        ? reference.route
        : withBasePath(reference.basePath, reference.route);
    const pages =
      reference.kind === "scalar"
        ? ""
        : ", with a page per operation (add `.md` for its Markdown)";
    return `- [${linkText(reference.label)}](${url(route)})${pages}.`;
  });

/** The skill's frontmatter `description`: what it's for and when to use it. */
const skillDescription = (project: BlumeProject): string => {
  const { description, title } = project.config;
  const summary = description ? ` ${description.trim()}` : "";
  return `Read ${docsPhrase(title, "docs")} instead of answering from memory.${summary} Use when a task involves ${title}: how it works, how to set it up or configure it, or its API.`.slice(
    0,
    SKILL_DESCRIPTION_MAX
  );
};

/** The site skill's `SKILL.md`. */
const skillMarkdown = (project: BlumeProject, name: string): string => {
  const { config } = project;
  const { site = "" } = config.deployment.options;
  const base = normalizeBasePath(config.deployment.options.base);
  // Mounted and encoded like llms.txt's links.
  const url = (path: string): string =>
    encodeURI(absoluteUrl(site, mountBasePath(base, path)));
  const markdownUrl = (route: string): string =>
    url(route === "/" ? "/index.md" : `${route}.md`);

  const map = new PageMap(mappedPages(project), markdownUrl);
  const pages = [
    ...map.level(project.graph.navigation.sidebar, 3),
    ...map.rest(),
  ];
  const { omitted } = map;
  if (omitted > 0) {
    pages.push(
      "",
      config.agents.llmsTxt.enabled
        ? `…and ${omitted} more. [llms.txt](${url("/llms.txt")}) lists every page.`
        : `…and ${omitted} more.`
    );
  }
  const references = referenceLines(project, url);

  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(skillDescription(project))}`,
    "---",
    "",
    `# ${config.title}`,
    "",
    ...(config.description ? [config.description.trim(), ""] : []),
    `This skill points you at ${docsPhrase(config.title, "docs")}, at ${url("/")}. When a task involves ${config.title}, read the relevant page before relying on what you remember: the docs are the source of truth, and they change.`,
    "",
    "## Reading the docs",
    "",
    ...surfaceLines(project, url),
    ...(references.length > 0
      ? ["", "## API reference", "", ...references]
      : []),
    ...(pages.length > 0 ? ["", "## Pages", "", ...pages] : []),
    "",
  ]
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n");
};

/**
 * The generated site skill, or `null` when `agents.skillMd` is off or there
 * is no `deployment.site` to make its links absolute.
 */
export const buildSiteSkill = (project: BlumeProject): SkillArtifact | null => {
  if (!generatesSiteSkill(project.config)) {
    return null;
  }
  const name = siteSkillName(project);
  return skillMdArtifact(
    name,
    skillDescription(project),
    skillMarkdown(project, name)
  );
};

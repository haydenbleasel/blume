import matter from "gray-matter";

import type { BlumeProject } from "../core/project-graph.ts";
import { readEntryText } from "../core/sources/read.ts";
import type { PageRecord } from "../core/types.ts";

const pageUrl = (route: string, site?: string): string => {
  if (!site) {
    return route;
  }
  return `${site.replace(/\/$/u, "")}${route}`;
};

const orderedPages = (project: BlumeProject): PageRecord[] =>
  [...project.graph.pages]
    .filter((page) => !page.meta.draft)
    .sort((a, b) => a.route.localeCompare(b.route));

/** Build the compact `llms.txt` index: title, summary, and links per page. */
const buildIndex = (project: BlumeProject): string => {
  const { config } = project;
  const { site } = config.deployment;
  const lines = [`# ${config.title}`];
  if (config.description) {
    lines.push("", `> ${config.description}`);
  }
  lines.push("", "## Docs", "");

  for (const page of orderedPages(project)) {
    const url = pageUrl(page.route, site);
    const summary = page.description ? `: ${page.description}` : "";
    lines.push(`- [${page.title}](${url})${summary}`);
  }

  return `${lines.join("\n")}\n`;
};

/** Build `llms-full.txt`: the full Markdown body of every page. */
const buildFull = async (project: BlumeProject): Promise<string> => {
  const { config } = project;
  const pages = orderedPages(project);

  const sections = await Promise.all(
    pages.map(async (page) => {
      const raw = await readEntryText(project, page);
      const body = matter(raw).content.trim();
      const url = pageUrl(page.route, config.deployment.site);
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

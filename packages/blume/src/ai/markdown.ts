import { mkdir, readFile, writeFile } from "node:fs/promises";

import matter from "gray-matter";
import { dirname, join } from "pathe";

import type { BlumeProject } from "../core/project-graph.ts";
import { readEntryText } from "../core/sources/read.ts";
import type { PageRecord, RouteManifestEntry } from "../core/types.ts";
import {
  rewriteMintlifyGlobalVariables,
  rewriteMintlifyMarkdownSnippets,
  rewriteMintlifySnippetVariables,
} from "../markdown/mintlify-snippets.ts";

const MDX_ESM_LINE = /^(?:import|export)\s.+$/gmu;
const VISIBILITY_BLOCK =
  /<Visibility\b(?<attributes>[^>]*)>(?<content>[\s\S]*?)<\/Visibility>/giu;
const VISIBILITY_SELF_CLOSING = /<Visibility\b[^>]*\/>/giu;
const VISIBILITY_FOR_QUOTED = /\bfor\s*=\s*["'](?<audience>[^"']+)["']/iu;
const VISIBILITY_FOR_EXPRESSION =
  /\bfor\s*=\s*\{\s*["'](?<audience>[^"']+)["']\s*\}/iu;
const H1 = /^#\s+/mu;

const isMintlifyProject = (project: BlumeProject): boolean =>
  project.context.configFile?.endsWith("docs.json") === true;

const markdownRouteForPage = (route: string): string =>
  route === "/" ? "/index.md" : `${route.replace(/\/$/u, "")}.md`;

export const markdownUrlForPage = (route: string, site?: string): string => {
  const markdownRoute = markdownRouteForPage(route);
  return site ? `${site.replace(/\/$/u, "")}${markdownRoute}` : markdownRoute;
};

const markdownOutputPath = (outDir: string, route: string): string =>
  join(outDir, markdownRouteForPage(route).slice(1));

const pageAccessGroups = (page: PageRecord): string[] => {
  const { groups } = page.meta as { groups?: unknown };
  if (Array.isArray(groups)) {
    return groups.filter((group): group is string => typeof group === "string");
  }
  return typeof groups === "string" ? [groups] : [];
};

export const isPublicAgentPage = (page: PageRecord): boolean =>
  pageAccessGroups(page).length === 0 ||
  (page.meta as { public?: unknown }).public === true;

export const sourceForMarkdown = async (
  project: BlumeProject,
  page: PageRecord
): Promise<string> => {
  const raw = await readEntryText(project, page);
  // Snippet/variable rewriting resolves include paths relative to the source
  // file; non-filesystem entries (no `sourcePath`) are never Mintlify content.
  if (!(isMintlifyProject(project) && page.sourcePath)) {
    return raw;
  }
  const { sourcePath } = page;

  const withSnippets = await rewriteMintlifyMarkdownSnippets(raw, {
    filePath: sourcePath,
    root: project.context.root,
  });
  const withSnippetVariables = await rewriteMintlifySnippetVariables(
    withSnippets,
    {
      filePath: sourcePath,
      root: project.context.root,
    }
  );
  return rewriteMintlifyGlobalVariables(
    withSnippetVariables,
    project.config.variables
  );
};

/**
 * Map every route to its Markdown source. Native Blume projects get the source
 * file verbatim; Mintlify projects get the same lightweight rewrites used by
 * the generated Markdown exports so snippets and local API pages stay visible.
 */
export const buildRawMarkdown = async (
  project: BlumeProject
): Promise<Record<string, string>> => {
  const pageById = new Map(project.graph.pages.map((page) => [page.id, page]));

  const readRoute = async (route: RouteManifestEntry): Promise<string> => {
    const page = pageById.get(route.id);
    if (page) {
      return await sourceForMarkdown(project, page);
    }
    return route.sourcePath ? await readFile(route.sourcePath, "utf-8") : "";
  };

  const entries = await Promise.all(
    project.manifest.routes.map(
      async (route) => [route.path, await readRoute(route)] as const
    )
  );
  return Object.fromEntries(entries);
};

const visibilityAudience = (attributes: string): string => {
  const match =
    attributes.match(VISIBILITY_FOR_QUOTED) ??
    attributes.match(VISIBILITY_FOR_EXPRESSION);
  return (match?.groups?.audience ?? "humans").toLowerCase();
};

const applyAgentVisibility = (markdown: string): string => {
  let previous = "";
  let current = markdown;
  while (current !== previous) {
    previous = current;
    current = current.replace(
      VISIBILITY_BLOCK,
      (_match, attributes: string, content: string) =>
        visibilityAudience(attributes) === "agents" ? content : ""
    );
  }
  return current.replaceAll(VISIBILITY_SELF_CLOSING, "");
};

/** Build the Markdown page body used for Mintlify-style `.md` exports. */
export const buildPageMarkdown = async (
  project: BlumeProject,
  page: PageRecord
): Promise<string> => {
  const source = await sourceForMarkdown(project, page);
  const body = applyAgentVisibility(matter(source).content)
    .replaceAll(MDX_ESM_LINE, "")
    .trim();
  const withTitle = H1.test(body) ? body : `# ${page.title}\n\n${body}`;
  return `${withTitle.trim()}\n`;
};

/** Write one `.md` file for every indexable route in the project. */
export const writeMarkdownExports = async (
  project: BlumeProject,
  outDir: string
): Promise<number> => {
  const pageById = new Map(project.graph.pages.map((page) => [page.id, page]));
  const publicRoutes = project.manifest.routes.filter((route) => {
    const page = pageById.get(route.id);
    return route.indexable && page !== undefined && isPublicAgentPage(page);
  });

  await Promise.all(
    publicRoutes.map(async (route) => {
      const page = pageById.get(route.id);
      if (!page) {
        return;
      }
      const output = markdownOutputPath(outDir, route.path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, await buildPageMarkdown(project, page), "utf-8");
    })
  );

  return publicRoutes.length;
};

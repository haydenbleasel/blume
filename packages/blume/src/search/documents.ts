import { readFile } from "node:fs/promises";

import matter from "gray-matter";

import type { BlumeProject } from "../core/project-graph.ts";
import {
  rewriteMintlifyGlobalVariables,
  rewriteMintlifyMarkdownSnippets,
  rewriteMintlifySnippetVariables,
} from "../markdown/mintlify-snippets.ts";

/** A document indexed by the Orama search provider. */
export interface SearchDocument {
  route: string;
  title: string;
  description: string;
  content: string;
}

const CODE_FENCE = /```[\s\S]*?```/gu;
const MDX_ESM_LINE = /^(?:import|export)\s.+$/gmu;
const INLINE_CODE = /`(?<code>[^`]+)`/gu;
const HTML_OR_JSX = /<[^>]+>/gu;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/gu;
const LINK = /\[(?<text>[^\]]*)\]\([^)]*\)/gu;
const HEADING_MARK = /^#{1,6}\s+/gmu;
const MARKDOWN_PUNCT = /[*_~>]+/gu;
const WHITESPACE = /\s+/gu;

/** Reduce Markdown/MDX to plain, searchable text. */
const toPlainText = (markdown: string): string =>
  markdown
    .replaceAll(MDX_ESM_LINE, " ")
    .replaceAll(CODE_FENCE, " ")
    .replaceAll(IMAGE, " ")
    .replaceAll(LINK, "$<text>")
    .replaceAll(HTML_OR_JSX, " ")
    .replaceAll(INLINE_CODE, "$<code>")
    .replaceAll(HEADING_MARK, "")
    .replaceAll(MARKDOWN_PUNCT, " ")
    .replaceAll(WHITESPACE, " ")
    .trim();

const sourceForSearch = async (options: {
  project: BlumeProject;
  raw: string;
  sourcePath: string;
}): Promise<string> => {
  const { project, raw, sourcePath } = options;
  if (project.context.configFile?.endsWith("docs.json") !== true) {
    return raw;
  }
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
 * Build search documents from the content graph. Only indexable pages are
 * included (per the route manifest), and content comes from the source files,
 * so the index is identical in dev and build.
 */
export const buildSearchDocuments = async (
  project: BlumeProject
): Promise<SearchDocument[]> => {
  const pageById = new Map(project.graph.pages.map((page) => [page.id, page]));

  const indexable = project.manifest.routes.filter((route) => route.indexable);

  return await Promise.all(
    indexable.map(async (route) => {
      const page = pageById.get(route.id);
      const raw = page ? await readFile(page.sourcePath, "utf-8") : "";
      const source =
        raw && page
          ? await sourceForSearch({
              project,
              raw,
              sourcePath: page.sourcePath,
            })
          : raw;
      const body = source ? toPlainText(matter(source).content) : "";
      return {
        content: body,
        description: page?.description ?? "",
        route: route.path,
        title: route.title,
      };
    })
  );
};

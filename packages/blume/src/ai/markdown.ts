import { readFile } from "node:fs/promises";

import type { BlumeProject } from "../core/project-graph.ts";
import { readEntryText } from "../core/sources/read.ts";
import type { RouteManifestEntry } from "../core/types.ts";

/**
 * Map every route to its raw source Markdown. Powers the `<route>.md` and
 * `<route>.mdx` endpoints, which serve the original source so AI tools — and
 * readers — can fetch any page as plain Markdown.
 */
export const buildRawMarkdown = async (
  project: BlumeProject
): Promise<Record<string, string>> => {
  const pageById = new Map(project.graph.pages.map((page) => [page.id, page]));

  const readRoute = async (route: RouteManifestEntry): Promise<string> => {
    const page = pageById.get(route.id);
    if (page) {
      return await readEntryText(project, page);
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

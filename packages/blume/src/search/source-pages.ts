import { relative } from "pathe";

import type { BlumeProject } from "../core/project-graph.ts";

/** Where a page is served, and its title: what a search hit links to. */
export interface SourcePage {
  title: string;
  url: string;
}

/**
 * Each search-indexable page's source file, relative to the project root,
 * paired with the page it renders. The Mixedbread endpoint links a hit to its
 * page through the path `mxbai store sync` recorded for the chunk's file,
 * which is relative to wherever the CLI ran: the project root, or a directory
 * above it in a monorepo. Pages from a source without local files have no
 * path to match and are left out.
 */
export const sourcePages = (project: BlumeProject): [string, SourcePage][] =>
  project.manifest.routes.flatMap((route): [string, SourcePage][] =>
    route.indexable && route.sourcePath
      ? [
          [
            relative(project.context.root, route.sourcePath),
            { title: route.title, url: route.path },
          ],
        ]
      : []
  );

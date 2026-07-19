import { readFile } from "node:fs/promises";

import matter from "../core/frontmatter.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { readEntryText } from "../core/sources/read.ts";
import type { RouteManifestEntry } from "../core/types.ts";
import { downlevelComponents } from "./component-markdown.ts";
import { applyAgentVisibility } from "./visibility.ts";

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
 * Map every route to its raw source Markdown. Powers the `<route>.md` and
 * `<route>.mdx` endpoints: `.mdx` serves the original source so tools can see
 * exactly what the author wrote, while `.md` downlevels supported components
 * to plain Markdown for consumers that can't interpret JSX. `<Visibility>`
 * audiences are resolved for agents in both variants: web-only content is
 * removed, agents-only unwrapped.
 */
export const buildRawMarkdown = async (
  project: BlumeProject
): Promise<Record<string, RawMarkdownEntry>> => {
  const pageById = new Map(project.graph.pages.map((page) => [page.id, page]));

  const readRoute = async (route: RouteManifestEntry): Promise<string> => {
    const page = pageById.get(route.id);
    if (page) {
      return await readEntryText(project, page);
    }
    return route.sourcePath ? await readFile(route.sourcePath, "utf-8") : "";
  };

  const entries = await Promise.all(
    project.manifest.routes.map(async (route) => {
      const source = applyAgentVisibility(await readRoute(route));
      // The `.md` variant keeps the front-matter block in the output, but its
      // data must also be in scope for `prop={frontmatter.*}` expressions.
      const md = downlevelComponents(
        source,
        project.config.ai.markdownComponents,
        matter(source).data
      );
      const entry: RawMarkdownEntry =
        md === source ? { mdx: source } : { md, mdx: source };
      return [route.path, entry] as const;
    })
  );
  return Object.fromEntries(entries);
};

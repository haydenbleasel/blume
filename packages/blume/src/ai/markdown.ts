import { readFile } from "node:fs/promises";

import { rewriteRelativeImages } from "../core/content-assets.ts";
import matter from "../core/frontmatter.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { readExpandedEntryText } from "../core/sources/read.ts";
import type { RouteManifestEntry } from "../core/types.ts";
import {
  downlevelComponents,
  exampleComponentSerializers,
} from "./component-markdown.ts";
import { buildLlmsIndex } from "./llms.ts";
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
 * Estimated token count of a Markdown document, for the `x-markdown-tokens`
 * response header (the convention Cloudflare's Markdown for Agents ships; the
 * tokenizer is unspecified there too, so this is the common ~4-characters-
 * per-token estimate). Kept in sync with the inline computation in
 * `rawMarkdownEndpointTemplate`, which can't import build-time code.
 */
export const markdownTokenCount = (text: string): number =>
  Math.ceil(text.length / 4);

/**
 * Map every route to its raw source Markdown. Powers the `<route>.md` and
 * `<route>.mdx` endpoints: `.mdx` serves the original source so tools can see
 * exactly what the author wrote, while `.md` downlevels supported components
 * to plain Markdown for consumers that can't interpret JSX. `<Visibility>`
 * audiences are resolved for agents in both variants: web-only content is
 * removed, agents-only unwrapped. Relative image references are rewritten to
 * their served `/blume-assets/content/…` URLs in both variants too — an agent
 * fetches these endpoints by URL, where a colocated `./diagram.png` resolves
 * to nothing.
 */
export const buildRawMarkdown = async (
  project: BlumeProject
): Promise<Record<string, RawMarkdownEntry>> => {
  const pageById = new Map(project.graph.pages.map((page) => [page.id, page]));

  // Downlevel `<Component>` to its example's source. A user `markdownComponents`
  // entry of the same name is spread last, so it still wins.
  const components = {
    ...exampleComponentSerializers(project.examples ?? {}),
    ...project.config.ai.markdownComponents,
  };

  const readRoute = async (route: RouteManifestEntry): Promise<string> => {
    const page = pageById.get(route.id);
    if (page) {
      return await readExpandedEntryText(project, page);
    }
    return route.sourcePath ? await readFile(route.sourcePath, "utf-8") : "";
  };

  const entries = await Promise.all(
    project.manifest.routes.map(async (route) => {
      let text = await readRoute(route);
      if (route.sourcePath) {
        text = rewriteRelativeImages({
          deployBase: project.config.deployment.base,
          projectRoot: project.context.root,
          source: text,
          sourcePath: route.sourcePath,
        });
      }
      const source = applyAgentVisibility(text);
      // The `.md` variant keeps the front-matter block in the output, but its
      // data must also be in scope for `prop={frontmatter.*}` expressions.
      const md = downlevelComponents(source, components, matter(source).data);
      const entry: RawMarkdownEntry =
        md === source ? { mdx: source } : { md, mdx: source };
      return [route.path, entry] as const;
    })
  );
  const map = Object.fromEntries(entries);
  // A landing-page homepage (user `.astro` page, or no home route at all) has
  // no Markdown source, but agents negotiating `Accept: text/markdown` on `/`
  // still expect a Markdown answer. The llms.txt index — the machine-readable
  // representation of the site a landing page fronts — becomes its mirror, so
  // `/index.md` always exists (see `markdownRoutePaths`).
  if (!map["/"]) {
    map["/"] = { mdx: buildLlmsIndex(project) };
  }
  return map;
};

/**
 * Every route path with a raw-Markdown mirror: the manifest routes, plus the
 * homepage when its mirror is the synthesized llms.txt fallback (see
 * `buildRawMarkdown`). This is the route list the negotiation surfaces (dev
 * middleware, Vercel routing config) and the homepage `Link` header build
 * from, so `Accept: text/markdown` on `/` resolves even when the homepage is
 * a landing page.
 */
export const markdownRoutePaths = (project: BlumeProject): string[] => {
  const paths = project.manifest.routes.map((route) => route.path);
  return paths.includes("/") ? paths : [...paths, "/"];
};

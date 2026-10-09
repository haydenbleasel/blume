import type { BlumeProject } from "../core/project-graph.ts";
import { buildSearchDocuments } from "../search/documents.ts";
import type { OramaDoc } from "../search/orama-index.ts";
import type { AskData } from "./ask-context.ts";
import { relativeLinkRewriter } from "./relative-links.ts";

/**
 * Build the grounding snapshot the assistant endpoint serves. Like the MCP server,
 * the assistant is independent of on-page search, so documents are indexed even when the
 * search provider is `none` (`includeWhenDisabled`). `locale` is kept so
 * retrieval can be filtered to the current page's language, and on a
 * versioned site `version` too, so archived snapshots don't crowd the docs
 * being read out of the answer. Content is kept as Markdown so grounding sees
 * fenced code examples — the model answers "what does the config look like?"
 * from the docs instead of declining.
 * The reader is an AI agent, so `<Visibility>` resolves for the agents audience
 * (web-only content removed, agents-only unwrapped) and components downlevel to
 * Markdown, both matching llms-full.txt. Relative page links point at the
 * routes they mean, as they do there too: the model cites the links it reads.
 * Only those are rewritten, and to routes without the `deployment.base`, like
 * the excerpt headings, since the chat panel mounts every link it renders
 * under the base; other links stay as written.
 */
export const buildAskData = async (project: BlumeProject): Promise<AskData> => {
  const documents = await buildSearchDocuments(project, {
    audience: "agents",
    content: "markdown",
    includeWhenDisabled: true,
  });
  const rewriteLinks = relativeLinkRewriter(project, { relativeOnly: true });
  const pageByRoute = new Map(
    project.graph.pages.map((page) => [page.route, page])
  );
  const versioned = Boolean(project.config.versions);
  const data: AskData = {
    defaultLocale: project.config.i18n?.defaultLocale,
    documents: documents.map((doc) => {
      const page = pageByRoute.get(doc.route);
      const document: OramaDoc = {
        content: rewriteLinks(doc.content, {
          entryId: page?.entryId,
          route: doc.route,
          sourcePath: page?.sourcePath,
        }),
        description: doc.description,
        locale: doc.locale,
        route: doc.route,
        title: doc.title,
      };
      if (versioned) {
        document.version = doc.version;
      }
      if (doc.boost !== undefined) {
        document.boost = doc.boost;
      }
      if (doc.keywords) {
        document.keywords = doc.keywords;
      }
      return document;
    }),
    site: project.config.deployment.options.site ?? null,
  };
  if (versioned) {
    data.versioned = true;
  }
  return data;
};

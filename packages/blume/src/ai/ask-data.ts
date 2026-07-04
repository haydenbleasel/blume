import type { BlumeProject } from "../core/project-graph.ts";
import { buildSearchDocuments } from "../search/documents.ts";
import type { AskData } from "./ask-context.ts";

/**
 * Build the grounding snapshot the Ask AI endpoint serves. Like the MCP server,
 * Ask AI is independent of on-page search, so documents are indexed even when the
 * search provider is `none` (`includeWhenDisabled`). `locale` is kept (unlike the
 * MCP snapshot) so retrieval can be filtered to the current page's language, and
 * content is kept as Markdown so grounding sees fenced code examples — the model
 * answers "what does the config look like?" from the docs instead of declining.
 */
export const buildAskData = async (project: BlumeProject): Promise<AskData> => {
  const documents = await buildSearchDocuments(project, {
    content: "markdown",
    includeWhenDisabled: true,
  });
  return {
    documents: documents.map((doc) => ({
      content: doc.content,
      description: doc.description,
      locale: doc.locale,
      route: doc.route,
      title: doc.title,
    })),
    site: project.config.deployment.site ?? null,
  };
};

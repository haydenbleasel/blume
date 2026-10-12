import type { BlumeProject } from "../core/project-graph.ts";
import { isOpenApiSource } from "../openapi/source.ts";
import { blogComponentSerializers } from "./blog-markdown.ts";
import { changelogComponentSerializers } from "./changelog-components.ts";
import type { ComponentMarkdown } from "./component-markdown.ts";
import { exampleComponentSerializers } from "./component-markdown.ts";
import { openapiComponentSerializers } from "./openapi-components.ts";

/**
 * Every serializer a project brings to a downlevel pass, layered once for all
 * the agent surfaces (`<route>.md`, llms-full.txt, the search and assistant
 * corpora): the built-in families that read project data — examples, then the
 * API reference, then the changelog and blog indexes — under the user's
 * `agents.markdownComponents`, which is spread last so an entry of the same
 * name still wins. One layering, so a new family or a new surface cannot leave
 * one consumer printing raw JSX.
 */
export const projectComponentSerializers = (project: BlumeProject) =>
  ({
    ...exampleComponentSerializers(project.examples ?? {}),
    ...openapiComponentSerializers(
      project.sources.find(isOpenApiSource)?.openApiData() ?? {},
      project.config.deployment.options.base
    ),
    ...changelogComponentSerializers(project),
    ...blogComponentSerializers(project),
    ...project.config.agents.markdownComponents,
  }) satisfies Record<string, ComponentMarkdown>;

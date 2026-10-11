import type { BlumeProject } from "../core/project-graph.ts";
import { isOpenApiSource } from "../openapi/source.ts";
import { changelogComponentSerializers } from "./changelog-components.ts";
import type { ComponentMarkdown } from "./component-markdown.ts";
import { exampleComponentSerializers } from "./component-markdown.ts";
import { openapiComponentSerializers } from "./openapi-components.ts";

/**
 * Every serializer a project brings to a downlevel pass, layered once for all
 * the agent surfaces (`<route>.md`, llms-full.txt, the search and assistant
 * corpora): the built-in families that read project data — examples, then the
 * API reference, then the changelog index — under the user's
 * `agents.markdownComponents`, which is spread last so an entry of the same
 * name still wins. One layering, so a new family or a new surface cannot leave
 * one consumer printing raw JSX. With `assistant`, the links the built-in
 * families write are routes, without the deployment base or site, as the
 * assistant's snapshot links pages: the chat panel mounts every link it
 * renders under the base, and `read_page` looks pages up by route.
 */
export const projectComponentSerializers = (
  project: BlumeProject,
  { assistant = false }: { assistant?: boolean } = {}
) =>
  ({
    ...exampleComponentSerializers(project.examples ?? {}),
    ...openapiComponentSerializers(
      project.sources.find(isOpenApiSource)?.openApiData() ?? {},
      assistant ? undefined : project.config.deployment.options.base
    ),
    ...changelogComponentSerializers(project, { assistant }),
    ...project.config.agents.markdownComponents,
  }) satisfies Record<string, ComponentMarkdown>;

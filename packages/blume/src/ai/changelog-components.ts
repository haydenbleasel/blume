import type { BlumeProject } from "../core/project-graph.ts";
import { changelogIndexBlocks } from "./changelog-markdown.ts";
import type { ComponentMarkdown } from "./component-markdown.ts";

/**
 * Downlevel `<Changelog />` to the release list it renders.
 *
 * The generated `/changelog` page publishes its list through
 * `buildChangelogIndexMarkdown`, but a hand-written page that owns the route
 * instead goes through the component downleveler — which leaves a tag it has
 * no serializer for exactly as written. Without this, moving to an authored
 * page would publish a literal `<Changelog />` to `/changelog.md`,
 * llms-full.txt, MCP `get_page` and the search corpus, and an agent would see
 * no releases at all.
 *
 * The list is the same one the mirror publishes, so both routes to a changelog
 * index — generated or authored — reach agents identically. For the
 * assistant's snapshot its links are routes, like the rest of its excerpts.
 */
export const changelogComponentSerializers = (
  project: BlumeProject,
  options: { assistant?: boolean } = {}
) =>
  ({
    // An empty changelog replaces the tag with nothing, so the page's own prose
    // is all an agent reads. Returning `null` would leave the tag as written.
    Changelog: () => changelogIndexBlocks(project, options).join("\n\n"),
  }) satisfies Record<string, ComponentMarkdown>;

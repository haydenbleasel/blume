import { routeIsTaken } from "../astro/pages.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { ResolvedConfig } from "../core/schema.ts";

/**
 * What a build actually serves of the agent surfaces whose config flag alone
 * doesn't guarantee them.
 */
export interface EmittedAgentSurface {
  /** The MCP server was generated (see {@link servesMcp}). */
  mcp: boolean;
  /**
   * A skills discovery index is served: generated from `agents.skills` (at
   * least one valid skill) or the site skill (`agents.skillMd`), or shipped
   * by the user in `public/`.
   */
  skills: boolean;
}

/**
 * Whether the build generates the MCP server: it is enabled and no content
 * or custom page owns its route. When one does, the generator skips the
 * server with a warning rather than collide with the page (`planMcp`).
 */
export const servesMcp = (
  project: BlumeProject,
  userPages: { pattern: string }[]
): boolean =>
  project.config.agents.mcp.enabled &&
  !routeIsTaken(
    userPages,
    project.graph.pages,
    project.config.agents.mcp.route
  );

/**
 * The config the discovery documents are built from: `agents.mcp`,
 * `agents.skills`, and `agents.skillMd` switched off when the build didn't
 * emit them, so llms.txt, agent-readability.json, the catalogs, and the
 * header rules only point at what is there. A config flag says what was asked
 * for; the MCP server is skipped when a page owns its route, and skills
 * publish nothing when their directory is missing or holds no valid skill.
 */
export const advertisedConfig = (
  config: ResolvedConfig,
  emitted: EmittedAgentSurface
): ResolvedConfig => ({
  ...config,
  agents: {
    ...config.agents,
    mcp: {
      ...config.agents.mcp,
      enabled: config.agents.mcp.enabled && emitted.mcp,
    },
    skillMd: config.agents.skillMd && emitted.skills,
    skills: emitted.skills ? config.agents.skills : undefined,
  },
});

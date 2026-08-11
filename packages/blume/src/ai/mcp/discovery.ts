import { withBasePath } from "../../core/base-path.ts";
import { trimChar, trimEnd } from "../../core/trim.ts";
import { MCP_TOOLS } from "./tools.ts";

/** Inputs needed to describe the MCP server in discovery documents. */
export interface McpDiscoveryInput {
  /** Normalized `deployment.base` (`""` or `/seg`); the route is base-less. */
  base: string;
  name: string;
  route: string;
  site: string | null;
  version: string;
}

/** The MCP server's address — absolute when a site is configured. */
const serverUrl = (input: McpDiscoveryInput): string => {
  // The endpoint is a generated Astro page, so it's served under
  // `deployment.base` like every other route (the sitemap/llms.txt convention).
  const path = withBasePath(input.base, input.route);
  // Concatenate rather than `new URL(path, site)` — a root-absolute path
  // would drop the base path of a subpath deployment (`acme.com/docs`).
  return input.site ? `${trimEnd(input.site, "/")}${path}` : path;
};

/**
 * The `/.well-known/mcp.json` discovery document: the minimal pointer agents use
 * to find the server and its transport.
 */
export const buildMcpDiscovery = (
  input: McpDiscoveryInput
): Record<string, unknown> => ({
  servers: [
    {
      name: input.name,
      transport: "streamable-http",
      url: serverUrl(input),
    },
  ],
});

/** The published `/v1/` Server Card schema (SEP-2127 extension). */
const SERVER_CARD_SCHEMA =
  "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";

/** The schema caps `description` (and `title`) at 100 characters. */
const CARD_TEXT_MAX = 100;

const truncate = (text: string): string =>
  text.length > CARD_TEXT_MAX ? `${text.slice(0, CARD_TEXT_MAX - 1)}…` : text;

// The server-card schema constrains `name` to `namespace/server` in ASCII
// (`^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`), so the display name cannot reuse the
// route slugifier, which keeps Unicode letters. Decompose (NFKD) and drop
// combining marks first so an accented name transliterates (`Café` → `cafe`)
// instead of losing the letter.
const NON_ASCII_SLUG = /[^a-z0-9]+/gu;
const COMBINING_MARKS = /\p{M}+/gu;

const asciiSlugify = (text: string): string =>
  trimChar(
    text
      .normalize("NFKD")
      .replace(COMBINING_MARKS, "")
      .toLowerCase()
      .replace(NON_ASCII_SLUG, "-"),
    "-"
  );

/**
 * The card's identity in the schema's reverse-DNS `namespace/server` form:
 * the site hostname reversed (`useblume.dev` → `dev.useblume`), or
 * `localhost` when no site is configured, plus the slugged display name (an
 * entirely non-ASCII name falls back to `docs`).
 */
const reverseDnsName = (input: McpDiscoveryInput): string => {
  let namespace = "localhost";
  if (input.site) {
    try {
      namespace = new URL(input.site).hostname
        .split(".")
        .toReversed()
        .join(".");
    } catch {
      // Not a parsable URL; the local namespace is honest enough.
    }
  }
  return `${namespace}/${asciiSlugify(input.name) || "docs"}`;
};

const HTTP_URL = /^https?:\/\//u;

/**
 * The `/.well-known/mcp/server-card.json` document. The core follows the
 * SEP-2127 Server Card extension schema (`$schema`, reverse-DNS `name`,
 * `remotes` — which the schema requires to be absolute, so it appears only
 * when a `site` is configured). Alongside it ride initialize-shaped compat
 * fields (`serverInfo`, `capabilities`, `transports`) for scanners built
 * against the SEP's earlier revision, plus Blume's advertised tool set —
 * schema-legal extras (`additionalProperties` is open), and the tool list is
 * genuinely static for a docs server, unlike the dynamic servers the spec
 * excludes primitives for. Full input schemas are served live via
 * `tools/list`.
 */
export const buildMcpServerCard = (
  input: McpDiscoveryInput
): Record<string, unknown> => {
  const url = serverUrl(input);
  return {
    $schema: SERVER_CARD_SCHEMA,
    capabilities: { tools: { listChanged: false } },
    description: truncate(
      `Model Context Protocol server for the ${input.name} documentation.`
    ),
    name: reverseDnsName(input),
    ...(HTTP_URL.test(url)
      ? { remotes: [{ type: "streamable-http", url }] }
      : {}),
    serverInfo: { name: input.name, version: input.version },
    title: truncate(input.name),
    tools: MCP_TOOLS.map((tool) => ({
      annotations: tool.annotations,
      description: tool.description,
      name: tool.name,
      title: tool.title,
    })),
    transport: "streamable-http",
    transports: [{ endpoint: url, type: "streamable-http" }],
    url,
    version: input.version,
    ...(input.site ? { websiteUrl: trimEnd(input.site, "/") } : {}),
  };
};

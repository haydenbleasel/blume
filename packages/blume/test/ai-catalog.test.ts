import { describe, expect, it } from "bun:test";

import {
  AI_CATALOG_PATH,
  AI_CATALOG_TYPE,
  ARD_MANIFEST_PATH,
  buildAiCatalog,
  crossOriginDiscoveryPaths,
  hasAiCatalog,
} from "../src/ai/ai-catalog.ts";
import type { SkillArtifact } from "../src/ai/skills.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { BlumeConfigInput } from "../src/core/schema.ts";
import { openapi, scalar } from "../src/reference/index.ts";

const configWith = (overrides: BlumeConfigInput = {}) =>
  blumeConfigSchema.parse({
    deployment: { site: "https://docs.example.com" },
    title: "Acme",
    ...overrides,
  });

const skill = (
  name: string,
  type: SkillArtifact["type"] = "skill-md"
): SkillArtifact => ({
  content: new Uint8Array(),
  description: `The ${name} skill.`,
  digest: "sha256:0",
  name,
  path: type === "archive" ? `${name}.tar.gz` : `${name}/SKILL.md`,
  type,
});

/** The parsed catalog, or a failing assertion when none was built. */
const parse = (
  config: ReturnType<typeof configWith>,
  skills: SkillArtifact[] = []
) => JSON.parse(buildAiCatalog(config, skills) ?? "null");

describe("buildAiCatalog", () => {
  it("catalogs the JSON docs API and llms.txt under a host identity by default", () => {
    const catalog = parse(configWith());
    expect(catalog.specVersion).toBe("1.0");
    expect(catalog.host).toStrictEqual({
      displayName: "Acme",
      documentationUrl: "https://docs.example.com/",
      identifier: "did:web:docs.example.com",
    });
    expect(catalog.entries).toStrictEqual([
      {
        description:
          "REST API over the Acme documentation: the page index, each page as JSON or Markdown, and the navigation tree, described by this OpenAPI document.",
        displayName: "Acme docs API",
        identifier: "urn:air:docs.example.com:api:docs",
        representativeQueries: [
          "fetch a Acme docs page as JSON",
          "list the pages in the Acme docs",
          "get the Acme docs navigation tree",
        ],
        type: "application/vnd.oai.openapi+json",
        url: "https://docs.example.com/openapi.json",
      },
      {
        description:
          "llms.txt index of the Acme documentation: every page with a one-line summary, plus the agent-facing resources on this site.",
        displayName: "Acme llms.txt",
        identifier: "urn:air:docs.example.com:docs:llms-txt",
        representativeQueries: [
          "what is Acme",
          "overview of the Acme documentation",
        ],
        type: "text/plain",
        url: "https://docs.example.com/llms.txt",
      },
    ]);
    expect(hasAiCatalog(configWith())).toBe(true);
  });

  it("needs a deployment.site to anchor the urn:air identifiers", () => {
    const config = configWith({ deployment: {} });
    expect(buildAiCatalog(config, [])).toBeNull();
    expect(hasAiCatalog(config)).toBe(false);
  });

  it("is off when agents.catalog is false or nothing is publishable", () => {
    expect(hasAiCatalog(configWith({ agents: { catalog: false } }))).toBe(
      false
    );
    const bare = configWith({ agents: { api: false, llmsTxt: false } });
    expect(hasAiCatalog(bare)).toBe(false);
    expect(buildAiCatalog(bare, [])).toBeNull();
  });

  it("catalogs the MCP server card with its tool capabilities", () => {
    const config = configWith({
      agents: {
        api: false,
        llmsTxt: false,
        mcp: {
          enabled: true,
          instructions: "Ask about Acme.",
          name: "Acme Docs",
        },
      },
    });
    const [entry] = parse(config).entries;
    expect(entry).toStrictEqual({
      capabilities: ["search_docs", "get_page", "list_pages", "get_navigation"],
      description: "Ask about Acme.",
      displayName: "Acme Docs",
      identifier: "urn:air:docs.example.com:mcp:acme-docs",
      representativeQueries: [
        "search the Acme documentation",
        "get a Acme docs page as Markdown",
        "list every page in the Acme docs",
      ],
      type: "application/mcp-server-card+json",
      url: "https://docs.example.com/.well-known/mcp/server-card.json",
    });
  });

  it("falls back to a generated MCP description and a `docs` name for a non-ASCII server name", () => {
    const config = configWith({
      agents: { api: false, llmsTxt: false, mcp: { enabled: true } },
      title: "文档",
    });
    const [entry] = parse(config).entries;
    expect(entry.identifier).toBe("urn:air:docs.example.com:mcp:docs");
    expect(entry.description).toBe(
      "Model Context Protocol server over the 文档 documentation: full-text search, page Markdown, the page index, and the navigation tree."
    );
  });

  it("catalogs each published skill by artifact type", () => {
    const config = configWith({
      agents: { api: false, llmsTxt: false, skills: "./skills" },
    });
    const { entries } = parse(config, [
      skill("blume"),
      skill("migrate", "archive"),
    ]);
    expect(entries).toStrictEqual([
      {
        description: "The blume skill.",
        displayName: "blume",
        identifier: "urn:air:docs.example.com:skill:blume",
        representativeQueries: [
          "load the blume agent skill",
          "how do I use blume",
        ],
        type: "application/agent-skills+md",
        url: "https://docs.example.com/.well-known/agent-skills/blume/SKILL.md",
      },
      {
        description: "The migrate skill.",
        displayName: "migrate",
        identifier: "urn:air:docs.example.com:skill:migrate",
        representativeQueries: [
          "load the migrate agent skill",
          "how do I use migrate",
        ],
        type: "application/agent-skills+gzip",
        url: "https://docs.example.com/.well-known/agent-skills/migrate.tar.gz",
      },
    ]);
    // Skills configured but none collected still counts as publishable.
    expect(hasAiCatalog(config)).toBe(true);
  });

  it("catalogs rendered API references at their docs route, under basePath and deployment.base", () => {
    const config = configWith({
      agents: { api: false, llmsTxt: false },
      basePath: "/docs",
      deployment: { base: "/site", site: "https://docs.example.com" },
      reference: [openapi({ route: "/reference", spec: "./openapi.json" })],
    });
    const [entry] = parse(config).entries;
    expect(entry).toStrictEqual({
      description:
        "API Reference: rendered OpenAPI reference in the Acme documentation.",
      displayName: "API Reference",
      identifier: "urn:air:docs.example.com:reference:reference",
      representativeQueries: [
        "what operations does the API Reference API expose",
        "how do I call the API Reference API",
      ],
      type: "text/html",
      url: "https://docs.example.com/site/docs/reference",
    });
    expect(parse(configWith()).host.documentationUrl).toBe(
      "https://docs.example.com/"
    );
  });

  it("keeps a Scalar-rendered reference at its raw route", () => {
    const config = configWith({
      agents: { api: false, llmsTxt: false },
      basePath: "/docs",
      reference: [
        openapi({
          renderer: scalar(),
          route: "/reference",
          spec: "./openapi.json",
        }),
      ],
    });
    expect(parse(config).entries[0].url).toBe(
      "https://docs.example.com/reference"
    );
  });

  it("replaces an entry's generated queries with the configured ones", () => {
    const config = configWith({
      agents: {
        catalog: { queries: { "api:docs": ["read the Acme API"] } },
        llmsTxt: false,
      },
    });
    expect(parse(config).entries[0].representativeQueries).toStrictEqual([
      "read the Acme API",
    ]);
    // `agents.catalog: true` is the same as the default object form.
    expect(
      parse(configWith({ agents: { catalog: true } })).entries
    ).toStrictEqual(parse(configWith()).entries);
  });

  it("pins the well-known paths and the registered media type", () => {
    expect(AI_CATALOG_PATH).toBe("/.well-known/ai-catalog.json");
    expect(ARD_MANIFEST_PATH).toBe("/.well-known/ard.json");
    expect(AI_CATALOG_TYPE).toBe("application/ai-catalog+json");
  });
});

describe("crossOriginDiscoveryPaths", () => {
  it("lists every discovery document registries fetch cross-origin", () => {
    expect(
      crossOriginDiscoveryPaths(
        configWith({ agents: { mcp: { enabled: true } } })
      )
    ).toStrictEqual([
      "/.well-known/ai-catalog.json",
      "/.well-known/ard.json",
      "/.well-known/api-catalog",
      "/.well-known/mcp.json",
      "/.well-known/mcp/server-card.json",
    ]);
  });

  it("is empty when nothing is published", () => {
    expect(
      crossOriginDiscoveryPaths(
        configWith({ agents: { api: false, llmsTxt: false }, deployment: {} })
      )
    ).toStrictEqual([]);
  });
});

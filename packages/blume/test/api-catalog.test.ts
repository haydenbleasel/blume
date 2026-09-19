import { describe, expect, it } from "bun:test";

import {
  API_CATALOG_PATH,
  API_CATALOG_TYPE,
  buildApiCatalog,
  hasApiCatalog,
} from "../src/ai/api-catalog.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { BlumeConfigInput } from "../src/core/schema.ts";
import { openapi } from "../src/reference/index.ts";

const configWith = (overrides: BlumeConfigInput = {}) =>
  blumeConfigSchema.parse({ title: "Docs", ...overrides });

describe("buildApiCatalog", () => {
  it("returns null when the site publishes no APIs", () => {
    const config = configWith({ ai: { api: false } });
    expect(buildApiCatalog(config)).toBeNull();
    expect(hasApiCatalog(config)).toBe(false);
  });

  it("catalogs the JSON docs API by default, described by its OpenAPI document", () => {
    const config = configWith({
      deployment: { base: "/site", site: "https://docs.example.com" },
    });
    const catalog = JSON.parse(buildApiCatalog(config) ?? "");
    expect(catalog.linkset).toEqual([
      {
        anchor: "https://docs.example.com/site/api/docs",
        "service-desc": [
          {
            href: "https://docs.example.com/site/openapi.json",
            type: "application/json",
          },
        ],
        "service-doc": [
          { href: "https://docs.example.com/site", type: "text/html" },
        ],
      },
    ]);
    expect(hasApiCatalog(config)).toBe(true);
  });

  it("catalogs an OpenAPI reference with absolute service links", () => {
    const config = configWith({
      ai: { api: false },
      deployment: { site: "https://docs.example.com" },
      reference: [
        openapi({
          route: "/reference",
          spec: "https://api.example.com/openapi.json",
        }),
      ],
    });
    const catalog = JSON.parse(buildApiCatalog(config) ?? "");
    expect(catalog.linkset).toEqual([
      {
        anchor: "https://docs.example.com/reference",
        "service-desc": [{ href: "https://api.example.com/openapi.json" }],
        "service-doc": [
          { href: "https://docs.example.com/reference", type: "text/html" },
        ],
      },
    ]);
  });

  it("omits service-desc for a local spec file", () => {
    const config = configWith({
      ai: { api: false },
      reference: [openapi({ spec: "./openapi.json" })],
    });
    const [entry] = JSON.parse(buildApiCatalog(config) ?? "").linkset;
    expect(entry["service-desc"]).toBeUndefined();
    expect(entry["service-doc"]).toEqual([
      { href: "/reference", type: "text/html" },
    ]);
  });

  it("mounts Blume-rendered references under basePath and deployment.base", () => {
    const config = configWith({
      ai: { api: false },
      basePath: "/docs",
      deployment: { base: "/site" },
      reference: [openapi({ spec: "./openapi.json" })],
    });
    const [entry] = JSON.parse(buildApiCatalog(config) ?? "").linkset;
    expect(entry.anchor).toBe("/site/docs/reference");
  });

  it("catalogs the hosted MCP server", () => {
    const config = configWith({
      ai: { api: false, mcp: { enabled: true } },
      deployment: { site: "https://docs.example.com" },
    });
    const catalog = JSON.parse(buildApiCatalog(config) ?? "");
    expect(catalog.linkset).toEqual([
      {
        anchor: "https://docs.example.com/mcp",
        "service-desc": [
          {
            href: "https://docs.example.com/.well-known/mcp.json",
            type: "application/json",
          },
        ],
        "service-doc": [
          { href: "https://docs.example.com/", type: "text/html" },
        ],
      },
    ]);
    expect(hasApiCatalog(config)).toBe(true);
  });

  it("pins the RFC 9727 path and linkset media type", () => {
    expect(API_CATALOG_PATH).toBe("/.well-known/api-catalog");
    expect(API_CATALOG_TYPE).toBe("application/linkset+json");
  });
});

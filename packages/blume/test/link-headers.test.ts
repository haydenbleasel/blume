import { describe, expect, it } from "bun:test";

import { buildHomeLinkHeader } from "../src/ai/link-headers.ts";
import type { ResolvedConfig } from "../src/core/schema.ts";

/** Treat a partial fixture as the full resolved config the header builder takes. */
const asResolvedConfig = <Fixture>(fixture: Fixture): ResolvedConfig =>
  // SAFETY: each caller populates every field buildHomeLinkHeader reads.
  fixture as ResolvedConfig;

const configWith = (
  overrides: Partial<{
    agentReadability: boolean;
    api: boolean;
    base: string;
    /** Sets a `deployment.site`, which the AI Catalog needs to anchor its URNs. */
    catalog: boolean;
    llmsTxt: boolean;
    mcp: boolean;
  }> = {}
): ResolvedConfig =>
  // SAFETY: buildHomeLinkHeader reads only the agents, api-reference, and
  // base fields populated here.
  asResolvedConfig({
    agents: {
      agentReadability: overrides.agentReadability ?? true,
      api: overrides.api ?? false,
      catalog: { enabled: true, queries: {} },
      llmsTxt: { enabled: overrides.llmsTxt ?? true },
      mcp: { enabled: overrides.mcp ?? false, route: "/mcp" },
      skills: undefined,
    },
    basePath: "",
    deployment: {
      options: {
        base: overrides.base,
        site: overrides.catalog ? "https://example.com" : undefined,
      },
    },
    reference: [],
  });

describe("buildHomeLinkHeader", () => {
  it("advertises the manifest, llms.txt, and the home Markdown mirror", () => {
    expect(buildHomeLinkHeader(configWith(), ["/", "/guide"])).toBe(
      [
        '</agent-readability.json>; rel="describedby"; type="application/json"',
        '</llms.txt>; rel="describedby"; type="text/plain"',
        '</index.md>; rel="alternate"; type="text/markdown"',
      ].join(", ")
    );
  });

  it("omits the alternate link when the home route has no Markdown mirror", () => {
    const header = buildHomeLinkHeader(configWith(), ["/docs/guide"]);
    expect(header).toContain("agent-readability.json");
    expect(header).not.toContain("index.md");
  });

  it("drops links whose feature is disabled", () => {
    expect(
      buildHomeLinkHeader(configWith({ agentReadability: false }), ["/"])
    ).toBe(
      [
        '</llms.txt>; rel="describedby"; type="text/plain"',
        '</index.md>; rel="alternate"; type="text/markdown"',
      ].join(", ")
    );
    expect(buildHomeLinkHeader(configWith({ llmsTxt: false }), [])).toBe(
      '</agent-readability.json>; rel="describedby"; type="application/json"'
    );
  });

  it("returns null when nothing is advertisable", () => {
    expect(
      buildHomeLinkHeader(
        configWith({ agentReadability: false, llmsTxt: false }),
        ["/docs/guide"]
      )
    ).toBeNull();
  });

  it("prefixes every target with deployment.base", () => {
    expect(buildHomeLinkHeader(configWith({ base: "/base/" }), ["/"])).toBe(
      [
        '</base/agent-readability.json>; rel="describedby"; type="application/json"',
        '</base/llms.txt>; rel="describedby"; type="text/plain"',
        '</base/index.md>; rel="alternate"; type="text/markdown"',
      ].join(", ")
    );
  });

  it("advertises the API catalog when the site publishes APIs (RFC 9727 §3)", () => {
    const header = buildHomeLinkHeader(configWith({ mcp: true }), []);
    expect(header).toContain(
      String.raw`</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json; profile=\"https://www.rfc-editor.org/info/rfc9727\""`
    );
    expect(buildHomeLinkHeader(configWith(), [])).not.toContain("api-catalog");
  });

  it("advertises the AI Catalog with its registered media type when a site anchors it", () => {
    expect(
      buildHomeLinkHeader(configWith({ base: "/base", catalog: true }), [])
    ).toBe(
      [
        '</base/.well-known/ai-catalog.json>; rel="ai-catalog"; type="application/ai-catalog+json"',
        '</base/agent-readability.json>; rel="describedby"; type="application/json"',
        '</base/llms.txt>; rel="describedby"; type="text/plain"',
      ].join(", ")
    );
    expect(buildHomeLinkHeader(configWith(), [])).not.toContain("ai-catalog");
  });

  it("advertises the OpenAPI description as service-desc (RFC 8631) with the JSON docs API", () => {
    expect(
      buildHomeLinkHeader(configWith({ api: true, base: "/base" }), ["/"])
    ).toBe(
      [
        String.raw`</base/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json; profile=\"https://www.rfc-editor.org/info/rfc9727\""`,
        '</base/openapi.json>; rel="service-desc"; type="application/json"',
        '</base/agent-readability.json>; rel="describedby"; type="application/json"',
        '</base/llms.txt>; rel="describedby"; type="text/plain"',
        '</base/index.md>; rel="alternate"; type="text/markdown"',
      ].join(", ")
    );
    expect(buildHomeLinkHeader(configWith(), [])).not.toContain("service-desc");
  });

  it("advertises only what the dev server serves on the dev surface", () => {
    // Every feature on: the build surface lists all six targets, but the
    // catalogs, the manifest, and llms.txt are files `blume build` writes, so
    // the dev server would answer each with a 404.
    const everything = configWith({
      api: true,
      base: "/base",
      catalog: true,
      mcp: true,
    });
    expect(buildHomeLinkHeader(everything, ["/"], "dev")).toBe(
      [
        '</base/openapi.json>; rel="service-desc"; type="application/json"',
        '</base/index.md>; rel="alternate"; type="text/markdown"',
      ].join(", ")
    );
    expect(buildHomeLinkHeader(everything, ["/"])).toBe(
      buildHomeLinkHeader(everything, ["/"], "build")
    );
    expect(buildHomeLinkHeader(everything, ["/"])?.split(", ")).toHaveLength(6);
    // Nothing the dev server serves is left to advertise.
    expect(buildHomeLinkHeader(configWith(), ["/docs"], "dev")).toBeNull();
  });
});

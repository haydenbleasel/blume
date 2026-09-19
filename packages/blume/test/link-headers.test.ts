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
  // SAFETY: buildHomeLinkHeader reads only the ai, api-reference, base, and
  // seo fields populated here.
  asResolvedConfig({
    ai: {
      api: overrides.api ?? false,
      catalog: { enabled: true, queries: {} },
      llmsTxt: { enabled: overrides.llmsTxt ?? true },
      mcp: { enabled: overrides.mcp ?? false, route: "/mcp" },
      skills: undefined,
    },
    basePath: "",
    deployment: {
      base: overrides.base,
      site: overrides.catalog ? "https://example.com" : undefined,
    },
    reference: [],
    seo: { agentReadability: overrides.agentReadability ?? true },
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
      '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"'
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
        '</base/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
        '</base/openapi.json>; rel="service-desc"; type="application/json"',
        '</base/agent-readability.json>; rel="describedby"; type="application/json"',
        '</base/llms.txt>; rel="describedby"; type="text/plain"',
        '</base/index.md>; rel="alternate"; type="text/markdown"',
      ].join(", ")
    );
    expect(buildHomeLinkHeader(configWith(), [])).not.toContain("service-desc");
  });
});

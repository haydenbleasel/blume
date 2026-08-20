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
    base: string;
    llmsTxt: boolean;
    mcp: boolean;
  }> = {}
): ResolvedConfig =>
  // SAFETY: buildHomeLinkHeader reads only the ai, api-reference, base, and
  // seo fields populated here.
  asResolvedConfig({
    ai: {
      llmsTxt: { enabled: overrides.llmsTxt ?? true },
      mcp: { enabled: overrides.mcp ?? false, route: "/mcp" },
    },
    asyncapi: { enabled: false, sources: [] },
    basePath: "",
    deployment: { base: overrides.base },
    openapi: { enabled: false, sources: [] },
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
});

import { describe, expect, it } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";
import type { ResolvedConfig } from "../src/core/schema.ts";
import {
  buildNetlifyHeaders,
  buildVercelHeaders,
} from "../src/deploy/headers.ts";

// A real zero-config parse, with the slices these tests vary layered on raw —
// `base`/`basePath` stay unnormalized so the builder's own handling is tested.
const configWith = (
  overrides: Partial<{
    api: boolean;
    base?: string;
    basePath: string;
    mcp: boolean;
    site: string;
    skills: string;
    poweredBy: boolean;
    webBotAuthKeys: { kty: string }[];
  }>
): ResolvedConfig => {
  const base = blumeConfigSchema.parse({});
  const options = { ...base.deployment.options };
  if (overrides.base) {
    options.base = overrides.base;
  }
  if (overrides.site) {
    options.site = overrides.site;
  }
  return {
    ...base,
    agents: {
      ...base.agents,
      api: overrides.api ?? true,
      mcp: { ...base.agents.mcp, enabled: overrides.mcp ?? false },
      skills: overrides.skills,
      webBotAuth: { keys: overrides.webBotAuthKeys ?? [] },
    },
    basePath: overrides.basePath ?? "",
    deployment: { ...base.deployment, options },
    poweredBy: overrides.poweredBy ?? base.poweredBy,
  };
};

describe("buildNetlifyHeaders", () => {
  it("omits the powered-by header when disabled", () => {
    expect(buildNetlifyHeaders(configWith({ poweredBy: false }))).not.toContain(
      "X-Powered-By"
    );
  });

  it("pins a UTF-8 Content-Type onto each raw endpoint extension", () => {
    expect(buildNetlifyHeaders(configWith({ api: false }))).toBe(
      [
        "/*.md",
        "  Content-Type: text/markdown; charset=utf-8",
        "/*.mdx",
        "  Content-Type: text/markdown; charset=utf-8",
        "/*.txt",
        "  Content-Type: text/plain; charset=utf-8",
        "/",
        "  X-Powered-By: Blume",
        "/*",
        "  X-Powered-By: Blume",
        "/blume-assets/*.svg",
        "  Content-Security-Policy: sandbox",
        "/blume-assets/*.svg",
        "  X-Content-Type-Options: nosniff",
        "",
      ].join("\n")
    );
  });

  it("sandboxes content-source SVGs under the deployment base", () => {
    const out = buildNetlifyHeaders(configWith({ base: "/docs" }));
    expect(out).toContain(
      "/docs/blume-assets/*.svg\n  Content-Security-Policy: sandbox"
    );
    expect(out).toContain(
      "/docs/blume-assets/*.svg\n  X-Content-Type-Options: nosniff"
    );
  });

  it("prefixes globs with deployment.base, beside basePath", () => {
    const out = buildNetlifyHeaders(
      configWith({ base: "/base", basePath: "/docs" })
    );
    // The section home's mirror (`/base/docs.md`) and the synthesized
    // `/base/index.md`, `/base/changelog.md`, and `/base/404.md` sit outside
    // basePath, and the glob spans segments, so one rule at the base covers
    // every mirror.
    expect(out).toContain("/base/*.md\n");
    expect(out).toContain("/base/*.mdx\n");
    expect(out).toContain("/base/*.txt\n");
    expect(out).not.toContain("/base/docs/*.");
  });

  it("adds the powered-by header at the deployment base and below it", () => {
    const out = buildNetlifyHeaders(configWith({ base: "/docs" }));
    expect(out).toContain("/docs/\n  X-Powered-By: Blume");
    expect(out).toContain("/docs/*\n  X-Powered-By: Blume");
  });

  it("normalizes a trailing slash on deployment.base", () => {
    expect(buildNetlifyHeaders(configWith({ base: "/docs/" }))).toContain(
      "/docs/*.md"
    );
  });

  it("keeps every rule at the root when only basePath is set", () => {
    const out = buildNetlifyHeaders(configWith({ basePath: "/docs" }));
    expect(out.startsWith("/*.md\n")).toBe(true);
    expect(out).toContain("\n/*.mdx\n");
    expect(out).toContain("\n/*.txt\n");
    expect(out).not.toContain("/docs/*.");
  });

  it("appends a homepage Link rule when a link header is provided", () => {
    const link = '</llms.txt>; rel="describedby"; type="text/plain"';
    expect(buildNetlifyHeaders(configWith({ api: false }), link)).toContain(
      `\n/\n  Link: ${link}\n`
    );
    // The homepage rule sits at the deployment base, not under basePath.
    const based = buildNetlifyHeaders(
      configWith({ base: "/base", basePath: "/docs" }),
      link
    );
    expect(based).toContain(`/base/\n  Link: ${link}`);
  });

  it("emits no Link rule without a link header", () => {
    expect(buildNetlifyHeaders(configWith({}))).not.toContain("Link:");
    expect(buildNetlifyHeaders(configWith({}), null)).not.toContain("Link:");
  });

  it("pins the API catalog media type when the site publishes APIs", () => {
    const out = buildNetlifyHeaders(
      configWith({ api: false, base: "/base", mcp: true })
    );
    expect(out).toContain(
      '/base/.well-known/api-catalog\n  Content-Type: application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"'
    );
    // The JSON docs API is on by default, and it is an API.
    expect(buildNetlifyHeaders(configWith({}))).toContain("api-catalog");
    expect(buildNetlifyHeaders(configWith({ api: false }))).not.toContain(
      "api-catalog"
    );
  });

  it("opens the discovery documents to cross-origin readers", () => {
    const out = buildNetlifyHeaders(
      configWith({ base: "/base", mcp: true, site: "https://example.com" })
    );
    for (const path of [
      "/base/.well-known/ai-catalog.json",
      "/base/.well-known/ard.json",
      "/base/.well-known/api-catalog",
      "/base/.well-known/mcp.json",
      "/base/.well-known/mcp/server-card.json",
    ]) {
      expect(out).toContain(`${path}\n  Access-Control-Allow-Origin: *`);
    }
    // No site, no catalog; no APIs, no CORS rule at all.
    expect(buildNetlifyHeaders(configWith({}))).not.toContain("ai-catalog");
    expect(buildNetlifyHeaders(configWith({ api: false }))).not.toContain(
      "Access-Control-Allow-Origin"
    );
  });

  it("pins agent-skill media types when skills are configured", () => {
    const out = buildNetlifyHeaders(
      configWith({ base: "/base", skills: "./skills" })
    );
    expect(out).toContain(
      "/base/.well-known/agent-skills/*.md\n  Content-Type: text/markdown; charset=utf-8"
    );
    expect(out).toContain(
      "/base/.well-known/agent-skills/*.tar.gz\n  Content-Type: application/gzip"
    );
    expect(buildNetlifyHeaders(configWith({}))).not.toContain("agent-skills");
  });

  it("pins the Web Bot Auth directory media type when keys are configured", () => {
    const out = buildNetlifyHeaders(
      configWith({ base: "/base", webBotAuthKeys: [{ kty: "OKP" }] })
    );
    expect(out).toContain(
      "/base/.well-known/http-message-signatures-directory\n  Content-Type: application/http-message-signatures-directory+json"
    );
    expect(buildNetlifyHeaders(configWith({}))).not.toContain(
      "http-message-signatures-directory"
    );
  });
});

describe("buildVercelHeaders", () => {
  it("carries the same rules as vercel.json sources", () => {
    const sources = buildVercelHeaders(
      configWith({ base: "/docs", basePath: "/guide" }),
      '</llms.txt>; rel="describedby"'
    );
    const bySource = new Map(
      sources.map((entry) => [entry.source, entry.headers])
    );
    // A `*` glob becomes the segment-spanning `(.*)` group.
    expect(bySource.get("/docs/(.*).md")).toStrictEqual([
      { key: "Content-Type", value: "text/markdown; charset=utf-8" },
    ]);
    expect(bySource.get("/docs/(.*).txt")).toStrictEqual([
      { key: "Content-Type", value: "text/plain; charset=utf-8" },
    ]);
    expect(bySource.get("/docs/(.*)")).toStrictEqual([
      { key: "X-Powered-By", value: "Blume" },
    ]);
    // The homepage rule drops its trailing slash, the URL Vercel serves.
    expect(bySource.get("/docs")).toStrictEqual([
      { key: "Link", value: '</llms.txt>; rel="describedby"' },
    ]);
    // Each header is its own entry, so a path with two (the API catalog's
    // media type and CORS) gets both.
    expect(
      sources
        .filter((entry) => entry.source === "/docs/.well-known/api-catalog")
        .map((entry) => entry.headers[0]?.key)
    ).toStrictEqual(["Content-Type", "Access-Control-Allow-Origin"]);
  });

  it("keeps the root homepage rule at / and escapes path syntax", () => {
    const sources = buildVercelHeaders(
      configWith({ api: false, base: "/v:1" }),
      "<x>"
    ).map((entry) => entry.source);
    expect(sources).toContain(String.raw`/v\:1`);
    expect(
      buildVercelHeaders(configWith({ api: false }), "<x>").map(
        (entry) => entry.source
      )
    ).toContain("/");
  });
});

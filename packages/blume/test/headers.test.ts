import { describe, expect, it } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";
import type { ResolvedConfig } from "../src/core/schema.ts";
import { buildNetlifyHeaders } from "../src/deploy/headers.ts";

// A real zero-config parse, with the slices these tests vary layered on raw —
// `base`/`basePath` stay unnormalized so the builder's own handling is tested.
const configWith = (
  overrides: Partial<{
    base?: string;
    basePath: string;
    mcp: boolean;
    skills: string;
    webBotAuthKeys: { kty: string }[];
  }>
): ResolvedConfig => {
  const base = blumeConfigSchema.parse({});
  return {
    ...base,
    ai: {
      ...base.ai,
      mcp: { ...base.ai.mcp, enabled: overrides.mcp ?? false },
      skills: overrides.skills,
      webBotAuth: { keys: overrides.webBotAuthKeys ?? [] },
    },
    basePath: overrides.basePath ?? "",
    deployment: { ...base.deployment, base: overrides.base },
  };
};

describe("buildNetlifyHeaders", () => {
  it("pins a UTF-8 Content-Type onto each raw endpoint extension", () => {
    expect(buildNetlifyHeaders(configWith({}))).toBe(
      [
        "/*.md",
        "  Content-Type: text/markdown; charset=utf-8",
        "/*.mdx",
        "  Content-Type: text/markdown; charset=utf-8",
        "/*.txt",
        "  Content-Type: text/plain; charset=utf-8",
        "",
      ].join("\n")
    );
  });

  it("prefixes globs with the composed deployment.base + basePath stack", () => {
    const out = buildNetlifyHeaders(
      configWith({ base: "/base", basePath: "/docs" })
    );
    expect(out).toContain("/base/docs/*.md");
    expect(out).toContain("/base/docs/*.mdx");
    // llms.txt / llms-full.txt live at the dist root, not under basePath.
    expect(out).toContain("/base/*.txt");
    expect(out).not.toContain("/base/docs/*.txt");
  });

  it("normalizes a trailing slash on deployment.base", () => {
    expect(buildNetlifyHeaders(configWith({ base: "/docs/" }))).toContain(
      "/docs/*.md"
    );
  });

  it("keeps the .txt rule at the root when only basePath is set", () => {
    const out = buildNetlifyHeaders(configWith({ basePath: "/docs" }));
    expect(out).toContain("/docs/*.md");
    expect(out).toContain("/*.txt");
    expect(out).not.toContain("/docs/*.txt");
  });

  it("appends a homepage Link rule when a link header is provided", () => {
    const link = '</llms.txt>; rel="describedby"; type="text/plain"';
    expect(buildNetlifyHeaders(configWith({}), link)).toEndWith(
      `/\n  Link: ${link}\n`
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
    const out = buildNetlifyHeaders(configWith({ base: "/base", mcp: true }));
    expect(out).toContain(
      "/base/.well-known/api-catalog\n  Content-Type: application/linkset+json"
    );
    expect(buildNetlifyHeaders(configWith({}))).not.toContain("api-catalog");
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

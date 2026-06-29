import { describe, expect, it } from "bun:test";

import { applyDeploymentEnv } from "../src/core/deployment-env.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { ResolvedConfig } from "../src/core/schema.ts";

/** A fully-resolved config with the given deployment overrides applied. */
const resolve = (deployment: Record<string, unknown> = {}): ResolvedConfig =>
  blumeConfigSchema.parse({ deployment });

const env = (vars: Record<string, string>): NodeJS.ProcessEnv =>
  vars as NodeJS.ProcessEnv;

describe("applyDeploymentEnv", () => {
  it("returns the config untouched when no platform env is present", () => {
    const config = resolve();
    expect(applyDeploymentEnv(config, env({}))).toBe(config);
  });

  it("infers the Vercel production site URL and prefixes https", () => {
    const result = applyDeploymentEnv(
      resolve(),
      env({ VERCEL: "1", VERCEL_PROJECT_PRODUCTION_URL: "docs.example.com" })
    );
    expect(result.deployment.site).toBe("https://docs.example.com");
  });

  it("prefers the production domain over the per-deploy VERCEL_URL", () => {
    const result = applyDeploymentEnv(
      resolve(),
      env({
        VERCEL: "1",
        VERCEL_PROJECT_PRODUCTION_URL: "docs.example.com",
        VERCEL_URL: "preview-abc123.vercel.app",
      })
    );
    expect(result.deployment.site).toBe("https://docs.example.com");
  });

  it("falls back to VERCEL_URL when no production domain is set", () => {
    const result = applyDeploymentEnv(
      resolve(),
      env({ VERCEL: "1", VERCEL_URL: "my-app.vercel.app" })
    );
    expect(result.deployment.site).toBe("https://my-app.vercel.app");
  });

  it("infers the adapter for server output", () => {
    const result = applyDeploymentEnv(
      resolve({ output: "server" }),
      env({ VERCEL: "1" })
    );
    expect(result.deployment.adapter).toBe("vercel");
  });

  it("does not infer an adapter for static output", () => {
    const result = applyDeploymentEnv(
      resolve({ output: "static" }),
      env({ VERCEL: "1", VERCEL_URL: "my-app.vercel.app" })
    );
    expect(result.deployment.adapter).toBeNull();
    // ...but the site origin is still inferred for static sitemaps/OG.
    expect(result.deployment.site).toBe("https://my-app.vercel.app");
  });

  it("never overrides an explicitly configured site", () => {
    const config = resolve({ site: "https://canonical.example.com" });
    const result = applyDeploymentEnv(
      config,
      env({ VERCEL: "1", VERCEL_URL: "my-app.vercel.app" })
    );
    expect(result).toBe(config);
    expect(result.deployment.site).toBe("https://canonical.example.com");
  });

  it("never overrides an explicitly configured adapter", () => {
    const result = applyDeploymentEnv(
      resolve({ adapter: "node", output: "server" }),
      env({ VERCEL: "1" })
    );
    expect(result.deployment.adapter).toBe("node");
  });

  it("infers Netlify, preferring the canonical URL", () => {
    const result = applyDeploymentEnv(
      resolve({ output: "server" }),
      env({
        DEPLOY_PRIME_URL: "https://branch--example.netlify.app",
        NETLIFY: "true",
        URL: "https://example.netlify.app",
      })
    );
    expect(result.deployment.adapter).toBe("netlify");
    expect(result.deployment.site).toBe("https://example.netlify.app");
  });

  it("infers Cloudflare Pages from CF_PAGES_URL", () => {
    const result = applyDeploymentEnv(
      resolve({ output: "server" }),
      env({ CF_PAGES: "1", CF_PAGES_URL: "https://example.pages.dev" })
    );
    expect(result.deployment.adapter).toBe("cloudflare");
    expect(result.deployment.site).toBe("https://example.pages.dev");
  });

  it("ignores blank env values", () => {
    const result = applyDeploymentEnv(
      resolve(),
      env({ VERCEL: "1", VERCEL_URL: "   " })
    );
    expect(result.deployment.site).toBeUndefined();
  });
});

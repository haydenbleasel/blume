import { describe, expect, it } from "bun:test";

import type { BlumeConfig } from "../src/core/config-input.ts";
import { applyDeploymentEnv } from "../src/core/deployment-env.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { ResolvedConfig } from "../src/core/schema.ts";
import {
  cloudflare,
  netlify,
  node,
  vercel,
} from "../src/deploy/adapters/index.ts";

/** A fully-resolved config with the given deployment applied. */
const resolve = (deployment?: BlumeConfig["deployment"]): ResolvedConfig =>
  blumeConfigSchema.parse(deployment ? { deployment } : {});

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars;

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
    expect(result.deployment.options.site).toBe("https://docs.example.com");
    // A static build stays static: only the site was filled in.
    expect(result.deployment.kind).toBe("static");
    expect(result.deployment.options.output).toBe("static");
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
    expect(result.deployment.options.site).toBe("https://docs.example.com");
  });

  it("falls back to VERCEL_URL when no production domain is set", () => {
    const result = applyDeploymentEnv(
      resolve(),
      env({ VERCEL: "1", VERCEL_URL: "my-app.vercel.app" })
    );
    expect(result.deployment.options.site).toBe("https://my-app.vercel.app");
  });

  it("falls through an empty VERCEL_PROJECT_PRODUCTION_URL to VERCEL_URL", () => {
    // A platform can set a var to the empty string; the chain must fall
    // through per resolved value instead of dead-ending on the empty one.
    const result = applyDeploymentEnv(
      resolve(),
      env({
        VERCEL: "1",
        VERCEL_PROJECT_PRODUCTION_URL: "",
        VERCEL_URL: "my-app.vercel.app",
      })
    );
    expect(result.deployment.options.site).toBe("https://my-app.vercel.app");
  });

  it("falls through empty Netlify URL vars to the first non-empty one", () => {
    const result = applyDeploymentEnv(
      resolve(),
      env({
        DEPLOY_PRIME_URL: "",
        DEPLOY_URL: "https://deploy-123.netlify.app",
        NETLIFY: "true",
        URL: "",
      })
    );
    expect(result.deployment.options.site).toBe(
      "https://deploy-123.netlify.app"
    );
  });

  it("fills the site of a host adapter from its own platform", () => {
    const result = applyDeploymentEnv(
      resolve(vercel()),
      env({ VERCEL: "1", VERCEL_URL: "my-app.vercel.app" })
    );
    expect(result.deployment.kind).toBe("vercel");
    expect(result.deployment.options.output).toBe("server");
    expect(result.deployment.options.site).toBe("https://my-app.vercel.app");
  });

  it("asks the configured adapter's platform before the others", () => {
    // Both platforms claim the env; the adapter the config names wins.
    const result = applyDeploymentEnv(
      resolve(netlify()),
      env({
        NETLIFY: "true",
        URL: "https://example.netlify.app",
        VERCEL: "1",
        VERCEL_URL: "my-app.vercel.app",
      })
    );
    expect(result.deployment.options.site).toBe("https://example.netlify.app");
  });

  it("falls back to whichever platform the build runs on", () => {
    // A Node server has no platform env of its own; building it on Netlify
    // still yields a canonical origin.
    const result = applyDeploymentEnv(
      resolve(node()),
      env({ NETLIFY: "true", URL: "https://example.netlify.app" })
    );
    expect(result.deployment.options.site).toBe("https://example.netlify.app");
  });

  it("never overrides an explicitly configured site", () => {
    const config = resolve({ site: "https://canonical.example.com" });
    const result = applyDeploymentEnv(
      config,
      env({ VERCEL: "1", VERCEL_URL: "my-app.vercel.app" })
    );
    expect(result).toBe(config);
    expect(result.deployment.options.site).toBe(
      "https://canonical.example.com"
    );
  });

  it("infers Netlify, preferring the canonical URL", () => {
    const result = applyDeploymentEnv(
      resolve(netlify()),
      env({
        DEPLOY_PRIME_URL: "https://branch--example.netlify.app",
        NETLIFY: "true",
        URL: "https://example.netlify.app",
      })
    );
    expect(result.deployment.options.site).toBe("https://example.netlify.app");
  });

  it("infers Cloudflare Pages from CF_PAGES_URL", () => {
    const result = applyDeploymentEnv(
      resolve(cloudflare()),
      env({ CF_PAGES: "1", CF_PAGES_URL: "https://example.pages.dev" })
    );
    expect(result.deployment.options.site).toBe("https://example.pages.dev");
  });

  it("ignores blank env values", () => {
    const config = resolve();
    const result = applyDeploymentEnv(
      config,
      env({ VERCEL: "1", VERCEL_URL: "   " })
    );
    expect(result).toBe(config);
    expect(result.deployment.options.site).toBeUndefined();
  });
});

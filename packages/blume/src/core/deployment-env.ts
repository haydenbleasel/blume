import type { ResolvedConfig } from "./schema.ts";

/** The deployment platforms Blume can infer from runtime/CI env vars. */
type DeploymentAdapter = NonNullable<ResolvedConfig["deployment"]["adapter"]>;

interface Platform {
  /** Astro adapter to use when building for server output on this platform. */
  adapter: DeploymentAdapter;
  /** True when the env indicates the build is running on this platform. */
  detect: (env: NodeJS.ProcessEnv) => boolean;
  /** Resolve the canonical site URL from the platform's env vars, or null. */
  site: (env: NodeJS.ProcessEnv) => string | null;
}

/** Prefix a bare host with `https://`; pass values that are already absolute. */
const toUrl = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return /^https?:\/\//u.test(trimmed) ? trimmed : `https://${trimmed}`;
};

/**
 * Platforms checked in order; the first whose `detect` matches wins. Site URLs
 * prefer the stable production domain over per-deployment preview URLs so the
 * inferred origin (sitemap, OG, RSS) stays put across deploys.
 */
const PLATFORMS: Platform[] = [
  {
    adapter: "vercel",
    detect: (env) => Boolean(env.VERCEL),
    site: (env) => toUrl(env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL),
  },
  {
    adapter: "netlify",
    detect: (env) => Boolean(env.NETLIFY),
    site: (env) => toUrl(env.URL ?? env.DEPLOY_PRIME_URL ?? env.DEPLOY_URL),
  },
  {
    adapter: "cloudflare",
    detect: (env) => Boolean(env.CF_PAGES),
    site: (env) => toUrl(env.CF_PAGES_URL),
  },
];

/**
 * Fill in `deployment.adapter` and `deployment.site` from platform env vars
 * (Vercel, Netlify, Cloudflare Pages) when the user hasn't set them. Explicit
 * config always wins, and the adapter is only inferred for server output (it
 * has no effect on static builds). Mirrors Astro's platform auto-detection so a
 * project deployed to a known host gets a working canonical origin for free.
 */
export const applyDeploymentEnv = (
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv = process.env
): ResolvedConfig => {
  const platform = PLATFORMS.find((candidate) => candidate.detect(env));
  if (!platform) {
    return config;
  }

  const { deployment } = config;
  const adapter =
    deployment.adapter ??
    (deployment.output === "server" ? platform.adapter : null);
  const site = deployment.site ?? platform.site(env) ?? undefined;

  if (adapter === deployment.adapter && site === deployment.site) {
    return config;
  }
  return { ...config, deployment: { ...deployment, adapter, site } };
};

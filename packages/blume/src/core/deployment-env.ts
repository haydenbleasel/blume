import { inferDeploymentSite } from "../deploy/platforms/index.ts";
import type { ResolvedConfig } from "./schema.ts";

/**
 * Fill in the deployment `site` from platform env vars (Vercel, Netlify,
 * Cloudflare Pages) when the config hasn't set one. Explicit config always
 * wins. Each adapter's platform declares its own detection and URL vars (see
 * `deploy/platforms/*`); the configured adapter is asked first, then every
 * other platform, so a static build deployed to a known host gets a working
 * canonical origin for free, mirroring Astro's platform auto-detection.
 */
export const applyDeploymentEnv = (
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv = process.env
): ResolvedConfig => {
  const { deployment } = config;
  if (deployment.options.site) {
    return config;
  }
  const site = inferDeploymentSite(deployment, env);
  if (!site) {
    return config;
  }
  return {
    ...config,
    deployment: {
      ...deployment,
      options: { ...deployment.options, site },
    },
  };
};

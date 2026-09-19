import type {
  DeployAdapterKind,
  ResolvedDeployment,
} from "../adapters/registry.ts";
import { cloudflarePlatform } from "./cloudflare.ts";
import { netlifyPlatform } from "./netlify.ts";
import { nodePlatform } from "./node.ts";
import { staticPlatform } from "./static.ts";
import type { DeployPlatform } from "./types.ts";
import { vercelPlatform } from "./vercel.ts";

/**
 * Every platform, in the order their env detection is tried when a build's
 * own adapter says nothing about where it runs (a static build on Vercel
 * still gets its site URL from `VERCEL_URL`).
 */
export const DEPLOY_PLATFORMS: readonly DeployPlatform[] = [
  vercelPlatform,
  netlifyPlatform,
  cloudflarePlatform,
  nodePlatform,
  staticPlatform,
];

const byKind = new Map<DeployAdapterKind, DeployPlatform>(
  DEPLOY_PLATFORMS.map((platform) => [platform.kind, platform])
);

/** The behaviors behind a resolved deployment descriptor. */
export const deployPlatform = (
  deployment: Pick<ResolvedDeployment, "kind">
): DeployPlatform => {
  const platform = byKind.get(deployment.kind);
  if (!platform) {
    throw new Error(`Unknown deployment adapter "${deployment.kind}".`);
  }
  return platform;
};

/**
 * The site URL the platform env implies, or null. The configured adapter's
 * own platform is asked first, then the rest in registration order, so a
 * static build (which names no host) still picks up the URL of whichever
 * platform it is building on.
 */
export const inferDeploymentSite = (
  deployment: Pick<ResolvedDeployment, "kind">,
  env: NodeJS.ProcessEnv
): string | null => {
  const own = deployPlatform(deployment);
  const candidates = [own, ...DEPLOY_PLATFORMS.filter((p) => p !== own)];
  const detected = candidates.find(
    (platform) => platform.env?.detect(env) ?? false
  );
  // `find` only returns a platform whose `env` matched, so it is present.
  return detected?.env?.site(env) ?? null;
};

export type {
  AstroAdapterSpec,
  BuildLog,
  DeployPlatform,
  FinalizeBuildOptions,
  HiddenRuntime,
  PlatformEnv,
  RedirectFile,
} from "./types.ts";

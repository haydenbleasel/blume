import { resolveAskBackend } from "../ai/ask.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import type { Diagnostic } from "../core/types.ts";

/** A feature, and the secrets the adapter behind it reads. */
interface SecretOwner {
  feature: string;
  note?: string;
  secrets: string[];
}

/**
 * The adapters that name their own secrets. The built-ins mostly declare
 * none: analytics ships public tokens in the page, consent managers load
 * public scripts, reference adapters read public specs, and host adapters
 * read platform-injected env.
 */
const adapterSecretOwners = (config: ResolvedConfig): SecretOwner[] => {
  const { consent, deployment, rateLimit } = config;
  const { provider } = config.search;
  const owners: SecretOwner[] = [
    // Each search adapter declares the secrets its generated runtime reads.
    { feature: `Search (${provider.kind})`, secrets: provider.requiredSecrets },
    ...config.analytics.map((adapter) => ({
      feature: `Analytics (${adapter.kind})`,
      secrets: adapter.requiredSecrets,
    })),
    // Each content source adapter declares the env vars its fetch reads.
    ...config.content.sources.map((source) => ({
      feature: `Content source (${source.kind})`,
      secrets: source.requiredSecrets,
    })),
    ...config.reference.map((adapter) => ({
      feature: `API reference (${adapter.kind})`,
      secrets: adapter.requiredSecrets,
    })),
    {
      feature: `Deployment (${deployment.kind})`,
      secrets: deployment.requiredSecrets,
    },
  ];
  if (consent) {
    owners.push({
      feature: `Consent (${consent.kind})`,
      secrets: consent.requiredSecrets,
    });
  }
  // Upstash's endpoint and token.
  if (rateLimit) {
    owners.push({
      feature: `Rate limiting (${rateLimit.kind})`,
      note: "read at request time; without it the routes count in memory",
      secrets: rateLimit.requiredSecrets,
    });
  }
  return owners;
};

/**
 * Warn early when an enabled feature needs a secret env var that isn't set, so
 * the failure surfaces at `blume dev`/`build` instead of at the first request in
 * production. These are runtime secrets (the endpoint reads them on the server),
 * so this warns rather than hard-fails — the value may live only in the deploy
 * environment. Build-time secrets (search-index sync) are checked by the sync.
 */
export const checkRequiredSecrets = (config: ResolvedConfig): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const requireSecret = (feature: string, env: string, note?: string): void => {
    if (process.env[env]) {
      return;
    }
    const noteSuffix = note ? ` (${note})` : "";
    diagnostics.push({
      code: "BLUME_MISSING_SECRET",
      message: `${feature} is enabled but ${env} is not set${noteSuffix}.`,
      severity: "warning",
      suggestion: `Set ${env} in .env.local for local dev, or in your host's environment for production.`,
    });
  };

  if (config.ai.assistant?.enabled && !config.ai.assistant.endpoint) {
    // The adapter descriptor names the env vars its route reads.
    const { captcha, provider } = config.ai.assistant;
    const backend = resolveAskBackend(provider);
    for (const env of provider.requiredSecrets) {
      requireSecret(`Assistant (${backend.label})`, env, backend.secretNote);
    }
    // The bot check's secret key, which the route verifies tokens with.
    for (const env of captcha?.requiredSecrets ?? []) {
      requireSecret(`Assistant bot check (${captcha?.kind})`, env);
    }
  }

  // Generated narration reads its key at build, not at runtime; without it the
  // build skips the audio and pages read with browser voices.
  const { narration } = config;
  if (narration.enabled && narration.provider) {
    for (const env of narration.provider.requiredSecrets) {
      requireSecret(
        "Narration audio",
        env,
        "read at build; without it pages use browser voices"
      );
    }
  }

  for (const owner of adapterSecretOwners(config)) {
    for (const env of owner.secrets) {
      requireSecret(owner.feature, env, owner.note);
    }
  }

  return diagnostics;
};

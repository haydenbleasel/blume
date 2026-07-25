import { resolveAskBackend } from "../ai/ask.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import type { Diagnostic } from "../core/types.ts";

/**
 * Warn early when an enabled feature needs a secret env var that isn't set, so
 * the failure surfaces at `blume dev`/`build` instead of at the first request in
 * production. These are runtime secrets (the endpoint reads them on the server),
 * so this warns rather than hard-fails — the value may live only in the deploy
 * environment. Build-time secrets (search-index sync) already warn during sync.
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

  if (config.ai.ask?.enabled && !config.ai.ask.endpoint) {
    const backend = resolveAskBackend(config.ai.ask);
    if (backend.kind === "gateway") {
      requireSecret(
        "Ask AI (AI Gateway)",
        "AI_GATEWAY_API_KEY",
        "on Vercel the gateway can also authenticate via OIDC"
      );
    } else {
      requireSecret("Ask AI", backend.apiKeyEnv);
    }
  }

  if (config.search.provider === "mixedbread") {
    requireSecret("Mixedbread search", "MIXEDBREAD_API_KEY");
  }

  return diagnostics;
};

import type { ResolvedConfig } from "../core/schema.ts";

/**
 * Web Bot Auth (IETF `webbotauth` WG): an org that runs agents publishes the
 * agents' HTTP Message Signature public keys in a JWKS at a well-known path
 * on its domain; sites receiving the signed requests fetch it to verify them.
 * Blume publishes the directory from `agents.webBotAuth.keys` — the schema admits
 * public keys only, so the site can never leak signing credentials.
 */

/** Well-known path (draft-meunier-http-message-signatures-directory). */
export const SIGNATURES_DIRECTORY_PATH =
  "/.well-known/http-message-signatures-directory";

/** The directory's registered media type — extensionless, so static hosts
 * need an explicit Content-Type rule (see `deploy/headers.ts` and the Vercel
 * `overrides` injection) to serve anything better than octet-stream. */
export const SIGNATURES_DIRECTORY_TYPE =
  "application/http-message-signatures-directory+json";

/** The JWKS document to publish, or null when no keys are configured. */
export const buildSignaturesDirectory = (
  config: ResolvedConfig
): string | null => {
  const { keys } = config.agents.webBotAuth;
  if (keys.length === 0) {
    return null;
  }
  return `${JSON.stringify({ keys }, null, 2)}\n`;
};

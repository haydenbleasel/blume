import { searchProviderMeta } from "../search/providers.ts";
import type { ResolvedConfig } from "./schema.ts";

/**
 * List the enabled features that require Astro server output. Static builds
 * fail clearly when any of these are enabled.
 */
export const serverFeatures = (config: ResolvedConfig): string[] => {
  const features: string[] = [];
  if (config.ai.ask?.enabled) {
    features.push("Ask AI");
  }
  // The hosted MCP server is a live JSON-RPC endpoint, so it needs a runtime.
  if (config.mcp.enabled) {
    features.push("MCP server");
  }
  // Mixedbread (and any future provider) that proxies queries through a secret
  // server endpoint can't run on a static build.
  if (searchProviderMeta(config.search.provider).requiresServer) {
    features.push(`Search (${config.search.provider})`);
  }
  return features;
};

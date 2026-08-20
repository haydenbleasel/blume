import { needsPlaygroundProxy } from "../openapi/references.ts";
import { searchProviderMeta } from "../search/providers.ts";
import type { ResolvedConfig } from "./schema.ts";

/**
 * List the enabled features that require Astro server output. Static builds
 * fail clearly when any of these are enabled.
 */
export const serverFeatures = (config: ResolvedConfig): string[] => {
  const features: string[] = [];
  if (config.ai.ask?.enabled && !config.ai.ask.endpoint) {
    features.push("Ask AI");
  }
  // The hosted MCP server is a live JSON-RPC endpoint, so it needs a runtime.
  if (config.ai.mcp.enabled) {
    features.push("MCP server");
  }
  // The built-in playground proxy (`playground.proxy: true` on the OpenAPI or
  // GraphQL block) is a live fetch endpoint at `/_api-proxy`; an external
  // proxy URL (string) or a proxy-less playground stays fully static.
  if (needsPlaygroundProxy(config)) {
    features.push("API playground proxy");
  }
  // Mixedbread (and any future provider) that proxies queries through a secret
  // server endpoint can't run on a static build.
  if (searchProviderMeta(config.search.provider).requiresServer) {
    features.push(`Search (${config.search.provider})`);
  }
  return features;
};

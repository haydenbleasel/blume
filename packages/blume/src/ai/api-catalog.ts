import {
  mountBasePath,
  normalizeBasePath,
  withBasePath,
} from "../core/base-path.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import { absoluteUrl } from "../core/site-url.ts";
import { resolveReferences } from "../openapi/references.ts";
import { API_BASE, OPENAPI_PATH } from "./api/paths.ts";

/**
 * RFC 9727 API catalog: a linkset (RFC 9264) at `/.well-known/api-catalog`
 * enumerating the APIs a publisher offers, so agents can discover them from
 * the domain alone. Blume already knows the site's APIs — the configured
 * OpenAPI/AsyncAPI references and the hosted MCP server — so the catalog is
 * generated, never hand-written: one entry per API, anchored at its docs
 * route (the RFC's own examples anchor on developer-portal pages), with
 * `service-doc` pointing at the rendered reference and `service-desc` at the
 * spec when it lives at a fetchable URL. The site's own JSON docs API is an
 * entry too, described by its generated `/openapi.json`.
 */

export const API_CATALOG_PATH = "/.well-known/api-catalog";
/** The profile URI RFC 9727 registers for an API catalog linkset. */
export const API_CATALOG_PROFILE = "https://www.rfc-editor.org/info/rfc9727";
/**
 * The catalog's media type: a linkset carrying the RFC 9727 profile
 * parameter, which the RFC says an API catalog SHOULD be served with.
 */
export const API_CATALOG_TYPE = `application/linkset+json; profile="${API_CATALOG_PROFILE}"`;

/** An RFC 9264 linkset entry, restricted to the relations Blume emits. */
interface LinksetEntry {
  anchor: string;
  "service-desc"?: { href: string; type?: string }[];
  "service-doc"?: { href: string; type: string }[];
}

const HTTP_URL = /^https?:\/\//u;

/** The catalog's linkset entries; empty when the site publishes no APIs. */
const linksetEntries = (config: ResolvedConfig): LinksetEntry[] => {
  const site = config.deployment.options.site ?? null;
  const deployBase = normalizeBasePath(config.deployment.options.base);
  const abs = (path: string): string => {
    const based = mountBasePath(deployBase, path);
    return site ? absoluteUrl(site, based) : based;
  };

  const entries: LinksetEntry[] = [];
  for (const reference of resolveReferences(config)) {
    // Blume-rendered pages mount under `basePath`; Scalar pages stay at the
    // raw route (see `referenceRoutes`).
    const docRoute =
      reference.kind === "scalar"
        ? reference.route
        : withBasePath(reference.basePath, reference.route);
    const entry: LinksetEntry = {
      anchor: abs(docRoute),
      "service-doc": [{ href: abs(docRoute), type: "text/html" }],
    };
    // A local spec file is parsed into pages, not served, so only a remote
    // spec has a fetchable `service-desc` URL.
    if (HTTP_URL.test(reference.spec)) {
      entry["service-desc"] = [{ href: reference.spec }];
    }
    entries.push(entry);
  }

  if (config.agents.api) {
    entries.push({
      anchor: abs(API_BASE),
      "service-desc": [{ href: abs(OPENAPI_PATH), type: "application/json" }],
      "service-doc": [{ href: abs("/"), type: "text/html" }],
    });
  }

  if (config.agents.mcp.enabled) {
    entries.push({
      anchor: abs(config.agents.mcp.route),
      "service-desc": [
        { href: abs("/.well-known/mcp.json"), type: "application/json" },
      ],
      "service-doc": [{ href: abs("/"), type: "text/html" }],
    });
  }
  return entries;
};

/** Whether the site has anything to catalog — gates every emission surface. */
export const hasApiCatalog = (config: ResolvedConfig): boolean =>
  linksetEntries(config).length > 0;

/** The `application/linkset+json` document, or null when there are no APIs. */
export const buildApiCatalog = (config: ResolvedConfig): string | null => {
  const linkset = linksetEntries(config);
  if (linkset.length === 0) {
    return null;
  }
  return `${JSON.stringify({ linkset }, null, 2)}\n`;
};

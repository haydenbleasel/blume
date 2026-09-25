import { normalizeBasePath } from "../core/base-path.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import {
  AI_CATALOG_PATH,
  AI_CATALOG_TYPE,
  hasAiCatalog,
} from "./ai-catalog.ts";
import {
  API_CATALOG_PATH,
  API_CATALOG_TYPE,
  hasApiCatalog,
} from "./api-catalog.ts";
import { OPENAPI_PATH } from "./api/paths.ts";

/**
 * The homepage `Link` response header (RFC 8288) — agent discovery for the
 * machine-readable surface Blume already publishes. Agents probing a site read
 * this header off `GET /` to find the resources without scraping HTML:
 * `agent-readability.json` and `llms.txt` as `rel="describedby"`, the OpenAPI
 * description of the JSON docs API as `rel="service-desc"`, and the
 * homepage's raw-Markdown mirror as `rel="alternate"` (only when the home
 * route is a content page — a user landing page has no mirror). Every rel
 * value is IANA-registered, which agent-readiness checkers require.
 *
 * The header is homepage-only by design: the root response is what agents
 * probe, and `agent-readability.json` indexes the rest of the surface (the
 * per-route Markdown pattern, MCP, feeds) far better than per-page headers
 * could. An agent that enters on a deep page (a search result, a shared link)
 * never sees this header at all — that path is covered in the HTML instead:
 * every page's `<head>` carries the same `describedby` links plus its own
 * Markdown mirror as an `alternate` (the `DiscoveryLinks.astro` partial every
 * layout renders), which also reaches hosts where Blume can't set response
 * headers. Targets are
 * root-relative under `deployment.base` — RFC 8288 resolves them against the
 * request URL. Returns null when nothing is advertisable.
 *
 * `surface` is where the header is sent. A deployed site (`"build"`) serves
 * every target. The dev server (`"dev"`) serves the routes — the JSON API's
 * OpenAPI document and the Markdown mirror — but not the files `blume build`
 * writes after the build (the API and AI catalogs, `agent-readability.json`,
 * `llms.txt`), so its header leaves those out rather than point agents at
 * 404s.
 */
export const buildHomeLinkHeader = (
  config: ResolvedConfig,
  routePaths: readonly string[],
  surface: "build" | "dev" = "build"
): string | null => {
  const deployBase = normalizeBasePath(config.deployment.options.base);
  const artifacts = surface === "build";
  const links: string[] = [];
  // RFC 9727 §3: the api-catalog relation is how a homepage advertises the
  // well-known catalog. Its type carries the RFC 9727 profile, whose quotes
  // are escaped inside the quoted `type` value (RFC 8288 quoted-string).
  if (artifacts && hasApiCatalog(config)) {
    links.push(
      `<${deployBase}${API_CATALOG_PATH}>; rel="api-catalog"; type="${API_CATALOG_TYPE.replaceAll('"', String.raw`\"`)}"`
    );
  }
  // The ai-catalog spec's own relation for its well-known document, the
  // header form of the `<link rel="ai-catalog">` every page carries.
  if (artifacts && hasAiCatalog(config)) {
    links.push(
      `<${deployBase}${AI_CATALOG_PATH}>; rel="ai-catalog"; type="${AI_CATALOG_TYPE}"`
    );
  }
  // RFC 8631: `service-desc` is the relation for a machine-readable
  // description of the service — the JSON docs API's OpenAPI document.
  if (config.agents.api) {
    links.push(
      `<${deployBase}${OPENAPI_PATH}>; rel="service-desc"; type="application/json"`
    );
  }
  if (artifacts && config.agents.agentReadability) {
    links.push(
      `<${deployBase}/agent-readability.json>; rel="describedby"; type="application/json"`
    );
  }
  if (artifacts && config.agents.llmsTxt.enabled) {
    links.push(
      `<${deployBase}/llms.txt>; rel="describedby"; type="text/plain"`
    );
  }
  // Same route list as the negotiation surfaces (`markdownRoutePaths`): "/"
  // always has a mirror — the page's own source when the home route is a
  // content page, the synthesized llms.txt fallback otherwise — so callers
  // passing that list always advertise `/index.md` here.
  if (routePaths.includes("/")) {
    links.push(
      `<${deployBase}/index.md>; rel="alternate"; type="text/markdown"`
    );
  }
  return links.length > 0 ? links.join(", ") : null;
};

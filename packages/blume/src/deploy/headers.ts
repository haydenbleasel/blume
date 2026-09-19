import { crossOriginDiscoveryPaths } from "../ai/ai-catalog.ts";
import {
  API_CATALOG_PATH,
  API_CATALOG_TYPE,
  hasApiCatalog,
} from "../ai/api-catalog.ts";
import {
  SIGNATURES_DIRECTORY_PATH,
  SIGNATURES_DIRECTORY_TYPE,
} from "../ai/web-bot-auth.ts";
import { normalizeBasePath } from "../core/base-path.ts";
import type { ResolvedConfig } from "../core/schema.ts";

/**
 * The `_headers` file for a static build (Netlify + Cloudflare Pages/Workers
 * static assets). Blume's raw AI-ready endpoints — `/<route>.md`, `/<route>.mdx`,
 * and the `.txt` files (`llms.txt`, `llms-full.txt`) — are valid UTF-8, but a
 * static host serves them from the file extension alone, and common hosts send
 * `text/markdown` / `text/plain` with **no** `charset`. Browsers then fall back
 * to Windows-1252 for non-HTML text, so any non-ASCII docs (Japanese, accented
 * Latin, …) render as mojibake when the raw URL is opened directly. HTML pages
 * escape this because they carry `<meta charset>`; the raw endpoints have only
 * the HTTP header. Pinning `charset=utf-8` here matches the Content-Type these
 * same routes already send from the dev/server runtime (see
 * `astro/templates.ts`). Hosts that don't read `_headers` (Vercel, S3) ignore
 * the file harmlessly.
 */

/**
 * One rule per served extension. `.mdx` uses `text/markdown` to match the
 * runtime endpoint, which serves both variants as `text/markdown`. The raw
 * Markdown mirrors live under the page routes (which carry `basePath`), while
 * the `.txt` files (`llms.txt`, `llms-full.txt`) are written to the dist root
 * and served at the deployment base — so only the `.md`/`.mdx` rules take the
 * `basePath` layer.
 */
const HEADER_RULES: readonly {
  contentType: string;
  ext: string;
  underBasePath: boolean;
}[] = [
  {
    contentType: "text/markdown; charset=utf-8",
    ext: "md",
    underBasePath: true,
  },
  {
    contentType: "text/markdown; charset=utf-8",
    ext: "mdx",
    underBasePath: true,
  },
  {
    contentType: "text/plain; charset=utf-8",
    ext: "txt",
    underBasePath: false,
  },
];

/**
 * `_headers` contents: a `/*.<ext>` glob per rule with an indented
 * `Content-Type` line, in the two-space format Netlify and Cloudflare read. The
 * glob carries the served prefix (`{deployment.base}{basePath}` for the
 * Markdown mirrors, `{deployment.base}` for the root `.txt` files) so the rules
 * still match once the site is mounted under a subpath (`/docs/*.md`); the
 * wildcard spans path segments, so a nested route like `/docs/ja/intro.md`
 * matches too.
 *
 * When a homepage `Link` header is provided (see `ai/link-headers.ts`), an
 * exact-path rule for the root page advertises the agent-discovery resources —
 * the static-host counterpart of the Vercel routing-config injection.
 */
export const buildNetlifyHeaders = (
  config: ResolvedConfig,
  homeLinkHeader?: string | null
): string => {
  const deployBase = normalizeBasePath(config.deployment.options.base);
  const rules = HEADER_RULES.map((rule) => {
    const prefix = rule.underBasePath
      ? `${deployBase}${config.basePath}`
      : deployBase;
    return `${prefix}/*.${rule.ext}\n  Content-Type: ${rule.contentType}`;
  });
  if (homeLinkHeader) {
    rules.push(`${deployBase}/\n  Link: ${homeLinkHeader}`);
  }
  // The well-known discovery files are extensionless, so without an explicit
  // rule a static host serves their registered media types as octet-stream or
  // text/plain.
  if (hasApiCatalog(config)) {
    rules.push(
      `${deployBase}${API_CATALOG_PATH}\n  Content-Type: ${API_CATALOG_TYPE}`
    );
  }
  if (config.agents.webBotAuth.keys.length > 0) {
    rules.push(
      `${deployBase}${SIGNATURES_DIRECTORY_PATH}\n  Content-Type: ${SIGNATURES_DIRECTORY_TYPE}`
    );
  }
  // Agent registries fetch the discovery documents cross-origin; a static
  // host sends no CORS header unless told to.
  for (const path of crossOriginDiscoveryPaths(config)) {
    rules.push(`${deployBase}${path}\n  Access-Control-Allow-Origin: *`);
  }
  // Published skills live at the deployment base, outside `basePath` — the
  // `.md` charset rule above misses them whenever a basePath is set, and the
  // RFC wants archives served as application/gzip explicitly.
  if (config.agents.skills) {
    rules.push(
      `${deployBase}/.well-known/agent-skills/*.md\n  Content-Type: text/markdown; charset=utf-8`,
      `${deployBase}/.well-known/agent-skills/*.tar.gz\n  Content-Type: application/gzip`
    );
  }
  return `${rules.join("\n")}\n`;
};

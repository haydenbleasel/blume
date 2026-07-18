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
 * runtime endpoint, which serves both variants as `text/markdown`.
 */
const HEADER_RULES: readonly { contentType: string; ext: string }[] = [
  { contentType: "text/markdown; charset=utf-8", ext: "md" },
  { contentType: "text/markdown; charset=utf-8", ext: "mdx" },
  { contentType: "text/plain; charset=utf-8", ext: "txt" },
];

/**
 * `_headers` contents: a `/*.<ext>` glob per rule with an indented
 * `Content-Type` line, in the two-space format Netlify and Cloudflare read. The
 * glob carries the composed `{deployment.base}{basePath}` stack so the rules
 * still match once the site is mounted under a subpath (`/docs/*.md`); the
 * wildcard spans path segments, so a nested route like `/docs/ja/intro.md`
 * matches too.
 */
export const buildNetlifyHeaders = (config: ResolvedConfig): string => {
  const prefix = `${normalizeBasePath(config.deployment.base)}${config.basePath}`;
  return `${HEADER_RULES.map(
    (rule) => `${prefix}/*.${rule.ext}\n  Content-Type: ${rule.contentType}`
  ).join("\n")}\n`;
};

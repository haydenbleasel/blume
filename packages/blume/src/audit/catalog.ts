import type { Diagnostic } from "../core/types.ts";
import type { CheckMeta } from "./types.ts";

/**
 * Every check `blume audit` can report.
 *
 * This is deliberately ~76 checks, not the ~173 rows an Ahrefs site audit
 * lists. Ahrefs crawls the open web, so its list is padded with rows that are
 * structurally impossible for an Astro-built Blume site, and shipping those as
 * permanent zeroes teaches people to ignore the report. What was dropped, and
 * why:
 *
 * - **Every `nofollow` check** (~6 rows, including all four "nofollow incoming
 *   internal links" variants). `RootLayout.astro` only ever emits `<meta
 *   name="robots" content="noindex">`; Blume has no way to emit `nofollow`, so
 *   they could never fire. Hand-written `rel="nofollow"` in MDX is still caught
 *   by `INTERNAL_LINK_NOFOLLOW`.
 * - **The whole JavaScript + CSS section** (~11 rows: "JS redirects", "CSS
 *   redirects", "page has redirected JS/CSS", "HTTPS page links to HTTP
 *   JS/CSS"…). Vite emits content-hashed, existent, non-redirecting bundles.
 *   Collapsed into one `SUBRESOURCE_MISSING`.
 * - **Ahrefs' indexable/non-indexable duplicates** (~20 rows). Carried instead
 *   by `PageSnapshot.indexable` on a single finding.
 * - **"Only one dofollow incoming internal link"** and **"page has no outgoing
 *   links"**. Blume's sidebar links every page from every page, so these fire on
 *   ~100% of pages. Pure noise.
 * - **"3XX redirect"** and **"302 redirect"**: having a redirect is inventory,
 *   not a finding. **"HTTP to HTTPS redirect"** is correct behavior.
 * - **"Font size too small" / "tap targets too close" / "content not sized
 *   correctly"**: properties of the theme, identical on every page. A regression
 *   there is a Blume bug, not a user finding.
 * - **"Document uses plugins"** and **"poor FID"** (FID is deprecated; lab
 *   Lighthouse cannot measure INP, so we report TBT and say so).
 * - **"More than three parameters in URL"**: a static docs site emits no query
 *   strings in its own links.
 * - **"Page in multiple sitemaps"**: Blume emits exactly one sitemap.
 * - **Core Web Vitals** (LCP/CLS/INP): these need a real browser. Rather than
 *   ship a `--lighthouse` flag that silently reports nothing, they are deferred
 *   until Lighthouse is actually wired in. A tier the audit cannot run is worse
 *   than one it openly doesn't have.
 *
 * Severity discipline: `error` means "this is definitely broken". Anything
 * advisory ships as `warning`/`info`. One noisy check and the whole command gets
 * switched off.
 */
export const CHECKS = [
  // Content
  {
    category: "content",
    fix: "Add a `title` to the page's frontmatter.",
    id: "BLUME_AUDIT_TITLE_MISSING",
    severity: "error",
    tier: "static",
    title: "Title tag missing or empty",
  },
  {
    category: "content",
    fix: "Remove the extra <title> from the page's layout or MDX.",
    id: "BLUME_AUDIT_TITLE_MULTIPLE",
    severity: "error",
    tier: "static",
    title: "Multiple title tags",
  },
  {
    category: "content",
    fix: "Rewrite `title` in the frontmatter to fit the length range.",
    id: "BLUME_AUDIT_TITLE_LENGTH",
    severity: "warning",
    tier: "static",
    title: "Title too long or too short",
  },
  {
    category: "content",
    fix: "Add a `description` to the page's frontmatter.",
    id: "BLUME_AUDIT_DESCRIPTION_MISSING",
    severity: "warning",
    tier: "static",
    title: "Meta description missing or empty",
  },
  {
    category: "content",
    fix: "Remove the extra description <meta> from the page's layout or MDX.",
    id: "BLUME_AUDIT_DESCRIPTION_MULTIPLE",
    severity: "error",
    tier: "static",
    title: "Multiple meta description tags",
  },
  {
    category: "content",
    fix: "Rewrite `description` in the frontmatter to fit the length range.",
    id: "BLUME_AUDIT_DESCRIPTION_LENGTH",
    severity: "warning",
    tier: "static",
    title: "Meta description too long or too short",
  },
  {
    category: "content",
    fix: "Give the page a `title` — Blume renders it as the page's <h1>.",
    id: "BLUME_AUDIT_H1_MISSING",
    severity: "warning",
    tier: "static",
    title: "H1 tag missing or empty",
  },
  {
    category: "content",
    fix: "Demote the extra `# Heading` in the body to `##` — Blume already renders `title` as the h1.",
    id: "BLUME_AUDIT_H1_MULTIPLE",
    severity: "warning",
    tier: "static",
    title: "Multiple H1 tags",
  },
  {
    category: "content",
    fix: "Expand the page, or fold it into a larger one.",
    id: "BLUME_AUDIT_LOW_WORD_COUNT",
    severity: "info",
    tier: "static",
    title: "Low word count",
  },
  {
    category: "content",
    fix: "Adjust the heading to the next level down — skipped levels break table-of-contents nesting and screen-reader outlines.",
    id: "BLUME_AUDIT_HEADING_SKIP",
    severity: "info",
    tier: "static",
    title: "Heading levels skip (e.g. h2 to h4)",
  },
  {
    category: "content",
    fix: "Correct the `date`, or hold the page back until it is meant to be live.",
    id: "BLUME_AUDIT_FUTURE_DATED_PAGE",
    severity: "info",
    tier: "static",
    title: "Page is dated in the future",
  },
  {
    category: "content",
    fix: "Restore the viewport <meta> in your ejected layout.",
    id: "BLUME_AUDIT_VIEWPORT_MISSING",
    severity: "error",
    tier: "static",
    title: "Viewport not set",
  },

  // Duplicates
  {
    category: "duplicates",
    fix: "Give each page a distinct `title` — search engines show it as the result headline.",
    id: "BLUME_AUDIT_DUPLICATE_TITLE",
    severity: "warning",
    tier: "static",
    title: "Duplicate title",
  },
  {
    category: "duplicates",
    fix: "Give each page a distinct `description`.",
    id: "BLUME_AUDIT_DUPLICATE_DESCRIPTION",
    severity: "warning",
    tier: "static",
    title: "Duplicate meta description",
  },
  {
    category: "duplicates",
    fix: "Merge the pages, or set `seo.canonical` on all but one.",
    id: "BLUME_AUDIT_DUPLICATE_CONTENT",
    severity: "warning",
    tier: "static",
    title: "Duplicate pages without canonical",
  },

  // Indexability
  {
    category: "indexability",
    fix: "Set `deployment.site` in blume.config.ts to the site's public URL.",
    id: "BLUME_AUDIT_SITE_NOT_SET",
    severity: "warning",
    tier: "static",
    title: "deployment.site is not set",
  },
  {
    category: "indexability",
    fix: "Audit a production-like build (e.g. `VERCEL=1 VERCEL_PROJECT_PRODUCTION_URL=<host> blume build`) or the deployment itself with `--url <origin>`. Do not hardcode `deployment.site` — the platform sets it on every deploy.",
    id: "BLUME_AUDIT_SITE_INFERRED_AT_DEPLOY",
    severity: "info",
    tier: "static",
    title: "deployment.site is inferred at deploy time",
  },
  {
    category: "indexability",
    fix: "Drop the canonical from noindex pages — Google treats the pairing as contradictory and may ignore one of the two.",
    id: "BLUME_AUDIT_CANONICAL_ON_NOINDEX",
    severity: "warning",
    tier: "static",
    title: "Page is noindex but declares a canonical",
  },
  {
    category: "indexability",
    fix: "Rebuild without `--preview` before deploying, or remove `draft: true` if the page is ready to ship.",
    id: "BLUME_AUDIT_DRAFT_PAGE_PUBLISHED",
    severity: "warning",
    tier: "static",
    title: "Draft page is in the build",
  },
  {
    category: "indexability",
    fix: "Set `deployment.site` so Blume can emit absolute canonical URLs.",
    id: "BLUME_AUDIT_CANONICAL_MISSING",
    severity: "warning",
    tier: "static",
    title: "Canonical URL missing",
  },
  {
    category: "indexability",
    fix: "Point `seo.canonical` at this page, or remove it to use the default self-canonical.",
    id: "BLUME_AUDIT_CANONICAL_NOT_SELF",
    severity: "info",
    tier: "static",
    title: "Non-canonical page",
  },
  {
    category: "indexability",
    fix: "Point `seo.canonical` at a page that exists and doesn't redirect.",
    id: "BLUME_AUDIT_CANONICAL_BAD_TARGET",
    severity: "error",
    tier: "static",
    title: "Canonical points to a broken or redirecting page",
  },
  {
    category: "indexability",
    fix: "Use the same protocol in `seo.canonical` as in `deployment.site`.",
    id: "BLUME_AUDIT_CANONICAL_PROTOCOL_MISMATCH",
    severity: "error",
    tier: "static",
    title: "Canonical protocol does not match the site",
  },
  {
    category: "indexability",
    fix: "Remove `noindex` from the page's frontmatter if it should be indexed.",
    id: "BLUME_AUDIT_ROBOTS_META_UNEXPECTED",
    severity: "info",
    tier: "static",
    title: "Page is not indexable",
  },
  {
    category: "indexability",
    fix: "Split the page — Googlebot stops reading an HTML document at 2 MB.",
    id: "BLUME_AUDIT_HTML_TOO_LARGE",
    severity: "error",
    tier: "static",
    title: "Page exceeds Googlebot's 2 MB crawl limit",
  },
  {
    category: "indexability",
    fix: "Remove the X-Robots-Tag header, or align it with the page's robots meta.",
    id: "BLUME_AUDIT_ROBOTS_HEADER_CONFLICT",
    severity: "error",
    tier: "network",
    title: "X-Robots-Tag header conflicts with the page's robots meta",
  },

  // Links
  {
    category: "links",
    fix: "Fix the link target, or create the page it points at.",
    id: "BLUME_AUDIT_LINK_TO_BROKEN",
    severity: "error",
    tier: "static",
    title: "Page has links to a broken page",
  },
  {
    category: "links",
    fix: "Link straight to the destination instead of through the redirect.",
    id: "BLUME_AUDIT_LINK_TO_REDIRECT",
    severity: "warning",
    tier: "static",
    title: "Page has links to a redirect",
  },
  {
    category: "links",
    fix: "Link to this page from the body of a related page.",
    id: "BLUME_AUDIT_ORPHAN_PAGE",
    severity: "warning",
    tier: "static",
    title: "Orphan page (only reachable from navigation)",
  },
  {
    category: "links",
    fix: "Use a root-relative path (`/docs/x`) so the link survives previews and `basePath`.",
    id: "BLUME_AUDIT_INTERNAL_LINK_ABSOLUTE",
    severity: "warning",
    tier: "static",
    title: "Internal link hardcodes the site's own origin",
  },
  {
    category: "links",
    fix: 'Drop `rel="nofollow"` — it stops this page passing authority internally.',
    id: "BLUME_AUDIT_INTERNAL_LINK_NOFOLLOW",
    severity: "info",
    tier: "static",
    title: "Page has nofollow outgoing internal links",
  },
  {
    category: "links",
    fix: "Check `basePath` / `deployment.base` — a trailing slash there produces `//`.",
    id: "BLUME_AUDIT_DOUBLE_SLASH_URL",
    severity: "error",
    tier: "static",
    title: "Double slash in URL",
  },
  {
    category: "links",
    fix: "Point the fragment at a heading that exists on the target page, or fix the heading it meant.",
    id: "BLUME_AUDIT_ANCHOR_BROKEN",
    severity: "warning",
    tier: "static",
    title: "Link fragment matches no id on the target page",
  },
  {
    category: "links",
    fix: "Rename the source file to a lowercase, hyphenated slug — and add a redirect from the old URL if it was already published.",
    id: "BLUME_AUDIT_URL_STYLE",
    severity: "info",
    tier: "static",
    title: "URL contains uppercase, underscores, or spaces",
  },

  // Redirects
  {
    category: "redirects",
    fix: "Point the redirect at a page that exists.",
    id: "BLUME_AUDIT_REDIRECT_BROKEN",
    severity: "error",
    tier: "static",
    title: "Broken redirect",
  },
  {
    category: "redirects",
    fix: "Break the cycle in `redirects` — it never resolves.",
    id: "BLUME_AUDIT_REDIRECT_LOOP",
    severity: "error",
    tier: "static",
    title: "Redirect loop",
  },
  {
    category: "redirects",
    fix: "Point every hop straight at the final destination.",
    id: "BLUME_AUDIT_REDIRECT_CHAIN",
    severity: "warning",
    tier: "static",
    title: "Redirect chain",
  },
  {
    category: "redirects",
    fix: "Use a real redirect in `blume.config.ts` instead of a meta refresh.",
    id: "BLUME_AUDIT_META_REFRESH",
    severity: "warning",
    tier: "static",
    title: "Meta refresh redirect",
  },
  {
    category: "redirects",
    fix: "Remove the redirect, or delete the page it shadows — the page wins and the redirect never fires.",
    id: "BLUME_AUDIT_REDIRECT_SOURCE_IS_PAGE",
    severity: "error",
    tier: "static",
    title: "Redirect source is also a real page",
  },
  {
    category: "redirects",
    fix: "Redirect to the HTTPS URL.",
    id: "BLUME_AUDIT_REDIRECT_TO_HTTP",
    severity: "error",
    tier: "network",
    title: "HTTPS to HTTP redirect",
  },

  // Social
  {
    category: "social",
    fix: "Add a `description` — Blume fills the rest of the Open Graph tags for you.",
    id: "BLUME_AUDIT_OG_INCOMPLETE",
    severity: "warning",
    tier: "static",
    title: "Open Graph tags missing or incomplete",
  },
  {
    category: "social",
    fix: "Set `deployment.site` to turn on generated OG images, or set `seo.image` on the page.",
    id: "BLUME_AUDIT_OG_IMAGE_MISSING",
    severity: "warning",
    tier: "static",
    title: "Open Graph image missing",
  },
  {
    category: "social",
    fix: "Point `seo.image` at a file that exists, or rebuild — a dead og:image renders as a blank card everywhere the page is shared.",
    id: "BLUME_AUDIT_OG_IMAGE_BROKEN",
    severity: "warning",
    tier: "static",
    title: "Open Graph image is not in the build",
  },
  {
    category: "social",
    fix: "Use an image of at least 1200×630 — smaller ones render blurry or get cropped into small-card layouts.",
    id: "BLUME_AUDIT_OG_IMAGE_SMALL",
    severity: "warning",
    tier: "static",
    title: "Open Graph image is too small for large cards",
  },
  {
    category: "social",
    fix: "Align `og:url` with the page's canonical URL.",
    id: "BLUME_AUDIT_OG_URL_MISMATCH",
    severity: "warning",
    tier: "static",
    title: "Open Graph URL not matching canonical",
  },
  {
    category: "social",
    fix: "Set `seo.x.handle` in blume.config.ts so X can attribute the card.",
    id: "BLUME_AUDIT_TWITTER_CARD_INCOMPLETE",
    severity: "warning",
    tier: "static",
    title: "X (Twitter) card missing or incomplete",
  },

  // Localization
  {
    category: "i18n",
    fix: "Restore the `lang` attribute on <html> in your ejected layout.",
    id: "BLUME_AUDIT_HTML_LANG_MISSING",
    severity: "error",
    tier: "static",
    title: "HTML lang attribute missing",
  },
  {
    category: "i18n",
    fix: "Use a valid BCP 47 tag (e.g. `en`, `en-GB`) for the locale.",
    id: "BLUME_AUDIT_HTML_LANG_INVALID",
    severity: "error",
    tier: "static",
    title: "HTML lang attribute invalid",
  },
  {
    category: "i18n",
    fix: "The page's <html lang> must match its own hreflang annotation.",
    id: "BLUME_AUDIT_HREFLANG_LANG_MISMATCH",
    severity: "error",
    tier: "static",
    title: "Hreflang and HTML lang mismatch",
  },
  {
    category: "i18n",
    fix: "Use a valid BCP 47 tag in the hreflang annotation.",
    id: "BLUME_AUDIT_HREFLANG_INVALID",
    severity: "error",
    tier: "static",
    title: "Hreflang annotation invalid",
  },
  {
    category: "i18n",
    fix: "A page's hreflang set must include a self-reference.",
    id: "BLUME_AUDIT_HREFLANG_SELF_MISSING",
    severity: "warning",
    tier: "static",
    title: "Self-reference hreflang annotation missing",
  },
  {
    category: "i18n",
    fix: "Add an `x-default` alternate pointing at the default-locale page.",
    id: "BLUME_AUDIT_HREFLANG_XDEFAULT_MISSING",
    severity: "info",
    tier: "static",
    title: "X-default hreflang annotation missing",
  },
  {
    category: "i18n",
    fix: "Every page in an hreflang group must link back to every other one.",
    id: "BLUME_AUDIT_HREFLANG_NO_RETURN_TAG",
    severity: "error",
    tier: "static",
    title: "Missing reciprocal hreflang (no return-tag)",
  },
  {
    category: "i18n",
    fix: "Point the hreflang alternate at a page that exists and is canonical.",
    id: "BLUME_AUDIT_HREFLANG_BAD_TARGET",
    severity: "error",
    tier: "static",
    title: "Hreflang points to a broken, redirecting, or non-canonical page",
  },
  {
    category: "i18n",
    fix: "Each language in an hreflang group must name exactly one page.",
    id: "BLUME_AUDIT_HREFLANG_CONFLICT",
    severity: "error",
    tier: "static",
    title: "Hreflang group has a language conflict",
  },

  // Assets
  {
    category: "assets",
    fix: 'Add descriptive `alt` text, or `alt=""` if the image is decorative.',
    id: "BLUME_AUDIT_IMAGE_ALT_MISSING",
    severity: "warning",
    tier: "static",
    title: "Missing alt text",
  },
  {
    category: "assets",
    fix: "Fix the image path, or add the file to public/.",
    id: "BLUME_AUDIT_IMAGE_BROKEN",
    severity: "error",
    tier: "static",
    title: "Image broken",
  },
  {
    category: "assets",
    fix: "Compress the asset, or serve a modern format (WebP/AVIF).",
    id: "BLUME_AUDIT_ASSET_TOO_LARGE",
    severity: "warning",
    tier: "static",
    title: "Asset file size too large",
  },
  {
    category: "assets",
    fix: "Set `width` and `height` so the browser can reserve space (avoids layout shift).",
    id: "BLUME_AUDIT_IMAGE_MISSING_DIMENSIONS",
    severity: "warning",
    tier: "static",
    title: "Image has no width/height",
  },
  {
    category: "assets",
    fix: "Fix the reference, or restore the missing file.",
    id: "BLUME_AUDIT_SUBRESOURCE_MISSING",
    severity: "error",
    tier: "static",
    title: "Referenced script, style, or asset is missing from the build",
  },
  {
    category: "assets",
    fix: "Load the subresource over HTTPS — browsers block mixed content.",
    id: "BLUME_AUDIT_MIXED_CONTENT",
    severity: "error",
    tier: "static",
    title: "HTTPS/HTTP mixed content",
  },

  // Sitemap
  {
    category: "sitemap",
    fix: "Remove `draft`/`hidden`/`noindex` from the page's frontmatter if it should be indexed.",
    id: "BLUME_AUDIT_INDEXABLE_PAGE_NOT_IN_SITEMAP",
    severity: "warning",
    tier: "static",
    title: "Indexable page not in sitemap",
  },
  {
    category: "sitemap",
    fix: "A noindex page should not be advertised in the sitemap.",
    id: "BLUME_AUDIT_NOINDEX_IN_SITEMAP",
    severity: "error",
    tier: "static",
    title: "Noindex page in sitemap",
  },
  {
    category: "sitemap",
    fix: "List only canonical URLs in the sitemap.",
    id: "BLUME_AUDIT_NON_CANONICAL_IN_SITEMAP",
    severity: "error",
    tier: "static",
    title: "Non-canonical page in sitemap",
  },
  {
    category: "sitemap",
    fix: "Remove the URL from the sitemap, or build the page it names.",
    id: "BLUME_AUDIT_SITEMAP_BAD_URL",
    severity: "error",
    tier: "static",
    title: "Sitemap names a page that does not exist or redirects",
  },
  {
    category: "sitemap",
    fix: "Sitemaps must be valid XML in the sitemaps.org urlset format.",
    id: "BLUME_AUDIT_SITEMAP_INVALID",
    severity: "error",
    tier: "static",
    title: "Sitemap has a syntax error or wrong format",
  },
  {
    category: "sitemap",
    fix: "Split the sitemap — the limits are 50 MB and 50,000 URLs.",
    id: "BLUME_AUDIT_SITEMAP_TOO_LARGE",
    severity: "error",
    tier: "static",
    title: "Sitemap exceeds 50 MB or 50,000 URLs",
  },
  {
    category: "sitemap",
    fix: "Use a real W3C date that is not in the future — search engines that catch a sitemap lying about freshness stop trusting its lastmod entirely.",
    id: "BLUME_AUDIT_SITEMAP_LASTMOD_INVALID",
    severity: "warning",
    tier: "static",
    title: "Sitemap lastmod is invalid or in the future",
  },
  {
    category: "sitemap",
    fix: "A sitemap may only list URLs on its own origin.",
    id: "BLUME_AUDIT_SITEMAP_OUT_OF_SCOPE",
    severity: "warning",
    tier: "static",
    title: "Sitemap includes URLs out of its scope",
  },
  {
    category: "sitemap",
    fix: "Make sitemap.xml reachable at the site root.",
    id: "BLUME_AUDIT_SITEMAP_NOT_ACCESSIBLE",
    severity: "error",
    tier: "network",
    title: "Sitemap is not accessible",
  },

  // robots.txt
  {
    category: "robots",
    fix: "Set `seo.robots: true` to generate robots.txt.",
    id: "BLUME_AUDIT_ROBOTS_MISSING",
    severity: "warning",
    tier: "static",
    title: "robots.txt missing",
  },
  {
    category: "robots",
    fix: "Every robots.txt line must be a `Field: value` directive or a comment.",
    id: "BLUME_AUDIT_ROBOTS_INVALID",
    severity: "error",
    tier: "static",
    title: "robots.txt has a syntax error",
  },
  {
    category: "robots",
    fix: "A page can't be both disallowed in robots.txt and advertised in the sitemap.",
    id: "BLUME_AUDIT_ROBOTS_DISALLOWS_INDEXABLE",
    severity: "error",
    tier: "static",
    title: "robots.txt disallows a page that is in the sitemap",
  },
  {
    category: "robots",
    fix: "Set `deployment.site` so robots.txt can reference the sitemap.",
    id: "BLUME_AUDIT_ROBOTS_SITEMAP_MISSING",
    severity: "info",
    tier: "static",
    title: "robots.txt does not reference the sitemap",
  },
  {
    category: "robots",
    fix: "Make robots.txt reachable at the site root.",
    id: "BLUME_AUDIT_ROBOTS_NOT_ACCESSIBLE",
    severity: "error",
    tier: "network",
    title: "robots.txt is not accessible",
  },

  // AI discovery. `llms.txt` is the sitemap of the AI era, and no SEO crawler
  // audits it — they audit for Google. Blume emits it, so Blume checks it.
  {
    category: "ai",
    fix: "Rebuild — `ai.llmsTxt` is enabled but the build has no llms.txt. If that's intentional, set `ai.llmsTxt: false`.",
    id: "BLUME_AUDIT_LLMS_TXT_MISSING",
    severity: "warning",
    tier: "static",
    title: "llms.txt missing from the build",
  },
  {
    category: "ai",
    fix: "Rebuild so llms.txt matches the site — a stale entry sends an AI agent to a page that is not there.",
    id: "BLUME_AUDIT_LLMS_TXT_STALE_ENTRY",
    severity: "warning",
    tier: "static",
    title: "llms.txt lists a page the build does not serve",
  },
  {
    category: "ai",
    fix: "Rebuild so llms.txt matches the site; if the page is deliberately excluded, mark it `seo.noindex` or `sidebar.hidden`.",
    id: "BLUME_AUDIT_LLMS_TXT_PAGE_MISSING",
    severity: "warning",
    tier: "static",
    title: "Indexable page missing from llms.txt",
  },

  // Structured data. Note we validate only what Blume itself emits — we do not
  // claim Google-rich-results or full schema.org validation (the former is an
  // undocumented network API, the latter a vocabulary we don't bundle).
  {
    category: "structured-data",
    fix: "The JSON-LD block must be valid JSON.",
    id: "BLUME_AUDIT_JSONLD_INVALID",
    severity: "error",
    tier: "static",
    title: "Structured data is not valid JSON",
  },
  {
    category: "structured-data",
    fix: "Every JSON-LD node needs `@context` and `@type`.",
    id: "BLUME_AUDIT_JSONLD_INCOMPLETE",
    severity: "warning",
    tier: "static",
    title: "Structured data is missing required properties",
  },

  // Network (`--url`)
  {
    category: "network",
    fix: "The page is linked or in the sitemap but the deployment 404s it.",
    id: "BLUME_AUDIT_HTTP_4XX",
    severity: "error",
    tier: "network",
    title: "4XX page",
  },
  {
    category: "network",
    fix: "The deployment is erroring on this page.",
    id: "BLUME_AUDIT_HTTP_5XX",
    severity: "error",
    tier: "network",
    title: "5XX page",
  },
  {
    category: "network",
    fix: "The page did not respond in time.",
    id: "BLUME_AUDIT_HTTP_TIMEOUT",
    severity: "error",
    tier: "network",
    title: "Timed out",
  },
  {
    category: "network",
    fix: "Enable gzip or brotli on the host.",
    id: "BLUME_AUDIT_NOT_COMPRESSED",
    severity: "warning",
    tier: "network",
    title: "Not compressed",
  },
  {
    category: "network",
    fix: "The page was slow to respond.",
    id: "BLUME_AUDIT_SLOW_RESPONSE",
    severity: "warning",
    tier: "network",
    title: "Slow page",
  },

  // External (`--external`)
  {
    category: "network",
    fix: "Fix or remove the outbound link.",
    id: "BLUME_AUDIT_EXTERNAL_LINK_BROKEN",
    severity: "error",
    tier: "external",
    title: "External link is broken",
  },
  {
    category: "network",
    fix: "Link straight to the destination.",
    id: "BLUME_AUDIT_EXTERNAL_LINK_REDIRECT",
    severity: "info",
    tier: "external",
    title: "External link redirects",
  },
] as const satisfies readonly CheckMeta[];

export type CheckId = (typeof CHECKS)[number]["id"];

const BY_ID = new Map<string, CheckMeta>(
  CHECKS.map((check) => [check.id, check])
);

export const checkMeta = (id: CheckId): CheckMeta => {
  const meta = BY_ID.get(id);
  if (!meta) {
    throw new Error(`Unknown audit check: ${id}`);
  }
  return meta;
};

const DOCS_BASE = "https://useblume.dev/docs/reference/audit";

/** `BLUME_AUDIT_TITLE_TOO_LONG` -> `…/audit#title-too-long`. */
export const checkDocsUrl = (id: CheckId): string =>
  `${DOCS_BASE}#${id.replace("BLUME_AUDIT_", "").toLowerCase().replaceAll("_", "-")}`;

/** Where a finding happened: the built URL, plus the source file that fixes it. */
export interface FindingSite {
  url: string;
  file?: string;
  line?: number;
  column?: number;
}

/**
 * Build a diagnostic for a check. Severity, remediation, and the docs anchor all
 * come from the catalog, so a check body only supplies what's specific to the
 * occurrence: where it happened and what was actually wrong.
 */
export const finding = (
  id: CheckId,
  site: FindingSite,
  detail: string,
  fix?: string
): Diagnostic => {
  const meta = checkMeta(id);
  return {
    code: id,
    column: site.column,
    docsUrl: checkDocsUrl(id),
    file: site.file,
    line: site.line,
    message: detail,
    severity: meta.severity,
    suggestion: fix ?? meta.fix,
    url: site.url,
  };
};

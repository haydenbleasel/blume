---
"blume": minor
---

Add `blume audit`, an offline site audit that replaces a hosted SEO crawler.

`blume audit` reads the built `dist/` HTML, joins each page back to the `.mdx` it came from, and reports SEO and site-health issues that name **both** the URL that is wrong and the front matter line that fixes it — something a crawler, which only ever sees the served page, structurally cannot do:

```
⚠ Meta description too long or too short   5 pages
    /docs/configuration/export    content/docs/configuration/export.mdx:3
    fix: Rewrite `description` in the frontmatter to fit the length range.
```

87 checks across content, duplicates, indexability, links, redirects, social tags, localization, assets, sitemap, robots.txt, structured data, and AI discovery. Meta descriptions are graded against Ahrefs' 110–160 character guidance. Findings are rolled up by check rather than dumped per page, and any tier that did not run says so rather than silently reporting nothing.

Pages that can't act on a finding aren't audited: `<Component />` example preview frames (bare iframe documents under `/blume-examples/`) are excluded from the crawl, and error routes (`/404`, `/500`) are never asked for a canonical.

The checks are platform-aware where the config is: on a Vercel/Netlify/Cloudflare adapter, a build without `deployment.site` reports `SITE_INFERRED_AT_DEPLOY` (info) — the platform sets the site from its env on every deploy, so the fix is to audit a production-like build or pass `--url`, never to hardcode the URL — instead of `SITE_NOT_SET` (warning), which remains the advice for projects with no platform to infer it from.

The check set is deliberately smaller than a general-purpose crawler's, because most of what such a crawler reports cannot happen to an Astro-built site: Blume never emits `rel=nofollow`, and Vite's content-hashed bundles are never missing or redirecting. Shipping those as permanent zeroes teaches people to ignore the report. In their place are checks a crawler can't do, including `INDEXABLE_PAGE_NOT_IN_SITEMAP` (a page a stray `draft`/`hidden` quietly excluded) and `REDIRECT_SOURCE_IS_PAGE` (a configured redirect shadowed by a real page, so it never fires).

Several checks go past a crawler's scope entirely:

- `ANCHOR_BROKEN` — a `#fragment` link whose target page has no such id. The page returns a healthy 200, so no crawler reports it; the reader just lands at the top, lost.
- `DRAFT_PAGE_PUBLISHED` — a page whose front matter says `draft: true` but that is in the build, the classic sign of a `--preview` build accidentally deployed. Only the manifest knows; the HTML looks perfectly ordinary.
- `LLMS_TXT_MISSING` / `LLMS_TXT_STALE_ENTRY` / `LLMS_TXT_PAGE_MISSING` — `llms.txt` held to the sitemap's standard. SEO crawlers audit for Google; nothing audits the AI-discovery surface, and Blume both emits it and checks it.
- `CANONICAL_ON_NOINDEX` — the contradictory pairing Google warns about. Blume's own layouts now suppress the canonical on noindex pages, so this guards regressions and ejected layouts.
- `OG_IMAGE_BROKEN` / `OG_IMAGE_SMALL` — the Open Graph image verified as bytes, not just a tag: it must exist in the build and be at least 600×315 (PNG/JPEG/GIF headers are read directly; no image library).
- `HEADING_SKIP`, `FUTURE_DATED_PAGE`, `SITEMAP_LASTMOD_INVALID` (malformed or future — a lying lastmod teaches crawlers to ignore all of them), and `URL_STYLE` (uppercase, underscores, or spaces in a slug, with the file rename as the fix).

Pass `--url <origin>` to also probe a live deployment for the things a `dist/` folder cannot show: a page that 404s behind a bad rewrite, a response that isn't compressed, or an `X-Robots-Tag` header quietly deindexing a page whose HTML looks fine. `--external` probes outbound links, grading a 404 as an error but a 403 or 5xx (usually rate limiting) as a warning.

Core Web Vitals are not included: they need a real browser, and a flag that quietly measured nothing would be worse than not having one.

Pass `--claude` or `--codex` to hand the findings to Claude Code or Codex: the audit writes the complete JSON report to a file and opens the agent interactively with a prompt to fix each finding at the source it names, then re-run `blume build` and `blume audit` until clean. The handoff is interactive by design — edits go through the agent's own permission flow rather than a headless process with blanket write access.

Other flags: `--fail-on <severity>` (default `error`) as the CI gate, `--only`/`--skip` to triage, `--json`, `--verbose`, and `--list-checks`.

`blume validate` is unchanged — it remains the fast source-level link check that needs no build.

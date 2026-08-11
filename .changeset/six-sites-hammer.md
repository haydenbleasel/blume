---
"blume": minor
---

Keep Unicode letters in OpenAPI tag slugs, and label tag sidebar groups with the spec's own tag names.

Slugs derived from OpenAPI tag names (and reference-source labels) now keep Unicode letters and numbers instead of stripping them to hyphens, with NFC normalization so canonically equivalent spellings share one slug. Sidebar groups for tag sections now take their label directly from the spec's `tags[].name` (overridable with a `meta.ts` title), so authored casing like `OAuth2`, `iOS SDK`, or `Größe` renders verbatim instead of being re-humanized from the slug. Canonical and `og:image` URLs percent-encode route-derived paths, matching the sitemap. The MCP server card's reverse-DNS `name` now transliterates to ASCII (`Café Docs` → `cafe-docs`) to stay within the registry schema.

**Note:** operation-page URLs change for specs whose tag names, operation ids, or source labels contain non-ASCII characters — `Größe` operations move from `/api/gr-e/...` to `/api/größe/...`, and previously letterless slugs leave the `operations` fallback. If such URLs are already deployed, add entries under `redirects` in `blume.config` to forward the old routes.

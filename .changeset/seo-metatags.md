---
"blume": patch
---

Add `seo.metatags` for tags written into every page's head: site-verification tokens, `theme-color`, an app banner, and anything else Blume has no setting for. Open Graph families render with `property` and everything else with `name`. A tag Blume writes itself, such as `description`, `robots`, `og:image`, or a `twitter:` card tag, is refused, and the build names the setting that controls it.

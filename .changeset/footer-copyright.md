---
"blume": patch
---

Add a copyright line to the site footer. `footer.copyright` in `blume.config.ts` takes plain text, like `© 2026 Acme, Inc.`, or a map of locale code to text, and shows it centered in the footer, between the links and the social icons; on narrow screens the row wraps. A footer with only a copyright line still renders. The `blume-migrate` skill now carries a source site's footer copyright over to it instead of dropping it.

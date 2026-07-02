---
"blume": patch
---

The Mintlify migrator now translates path-to-regexp wildcard redirects into Astro's dynamic-segment syntax. Previously `mintlifyRedirects` copied `from`/`to` verbatim, so a `/old/:slug*` → `/new/:slug*` redirect reached Astro's `redirects` unchanged and never matched. Both sides of each redirect are now converted (repeatable params `:name*`/`:name+` → `[...name]`, others → `[name]`), preserving the param name so Astro can substitute it into the destination.

---
"blume": patch
---

A protocol-relative `navigation.featured` href (`//host/path`) no longer picks up a locale prefix on non-default locales, where it became `/fr//host/path`. `localizePath` now draws the same line as `withBasePath`: a leading slash alone doesn't make a route.

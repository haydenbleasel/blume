---
"blume": patch
---

Hardened theme and OG rendering against hostile-shaped config and content values. A `theme.accent` (or icon name/library) matching an `Object.prototype` member like `constructor` resolved a function up the prototype chain — stringifying into the generated CSS or crashing icon resolution mid-build with no pointer to the offending page; lookups are now own-property only. A malformed hex accent (`#12345`) no longer throws a native error inside the OG renderer and fails the build — it falls back to the default accent. The OG logo viewBox parser now also accepts single-quoted attributes and non-zero origins, so wide wordmarks keep their aspect ratio instead of being squeezed into a square.

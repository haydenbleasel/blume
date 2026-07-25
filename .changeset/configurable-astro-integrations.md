---
"blume": patch
---

Add a top-level `integrations` array to `blume.config.ts` for registering Astro integrations. Entries are schema-validated as an array (each element is left for Astro to validate) and appended after Blume's built-in integrations in declaration order, with no sorting or deduplication. The generated Astro config loads them through a portable bridge back to `blume.config.ts` rather than serializing the instances, so function-bearing hooks survive across build, `blume dev`, config regeneration, and eject. Install and version each integration in the site itself — Blume neither adds it to the runtime's dependencies nor manages its Astro compatibility.

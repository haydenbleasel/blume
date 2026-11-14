---
"blume": patch
---

Stop `blume build` from warning `'highlight' is not recognized as a valid pseudo-element` in projects whose lockfile kept an older Vite. Tailwind CSS 4.3.3 and earlier pin LightningCSS 1.32 exactly, and package managers shared that copy with Vite's CSS minifier, which doesn't understand the `::highlight()` rule the narration player uses to shade the sentence being read. Blume now requires Tailwind CSS 4.3.5 and Astro 7.3.6 or later, which bring LightningCSS 1.33 and Vite 8.3.

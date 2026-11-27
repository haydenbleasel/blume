---
"blume": patch
---

Keep `blume dev` running when Astro reports an unhandled rejection. Since Astro 7.3.3, a config restart can strand a request while the dev app is still compiling. That happens when `blume dev` moves off a taken port with a browser already open, or after two quick edits to `blume.config.ts`. Astro's dev server reports the error and keeps serving, but Blume exited with `BLUME_INTERNAL`. Once the dev server is up, Blume now leaves those errors to Astro, as `astro dev` does.

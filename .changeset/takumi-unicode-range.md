---
"blume": patch
---

Fix `blume build` failing in `renderOgImage` with `TypeError: Cannot read properties of undefined (reading 'length')` once a project's lock file resolved takumi-js to 2.16 or newer, which changed the shape of the Google Fonts subsets Blume reads. Blume now pins takumi-js to 2.17.1, so a later Takumi release can't break published versions or change cached cards without a Blume release. A vertical tab, next line, or line or paragraph separator in a title or description now draws as a space, where Takumi 2.17 would draw a missing-glyph box. A font fetch that fails during `blume dev` is now retried on the next card instead of failing every card until the server restarts.

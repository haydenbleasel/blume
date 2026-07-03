---
"blume": patch
---

Migrators now convert nested callouts correctly. The callout-to-directive rewrite found its close tag with a flat string search, so `<Warning>… <Info>…</Info> …</Warning>` left the inner component unconverted (failing the build — Blume ships no `<Info>`), and same-tag nesting closed at the inner tag, leaking a stray `</Note>` into the page (an MDX compile error). Close tags are now matched depth-aware, inner bodies are converted recursively, and outer directive fences grow (`::::`) so nested `:::` blocks parse as containers. Applies to the Mintlify, Fumadocs, Nextra, and Starlight migrators.

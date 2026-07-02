---
"blume": minor
---

Blume's own diagnostics (invalid config, frontmatter, or content errors) now show
in the browser error overlay during `blume dev`, not just the terminal — each
with its code, file/line, fix hint, and docs link. The overlay updates on every
save and clears on the next successful reload.

---
"blume": patch
---

Git-derived "Last updated" dates now follow each filesystem source's own root: with `lastModified: true` and a source configured with a non-default `root` (e.g. `documentation/`), the `git log` pathspec previously pointed at the global `content.root` (`docs/`), so every page silently lost its date.

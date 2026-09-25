---
"blume": patch
---

`blume dev` reloads on edits under a nested folder that shares a name with an excluded one. With `exclude: ["drafts/**"]`, which leaves out `drafts/` at the content root only, the watcher used to ignore every folder named `drafts`, so edits to pages in `guides/drafts/` never showed up until a restart.

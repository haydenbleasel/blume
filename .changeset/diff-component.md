---
"blume": patch
---

Add `<Diff>` — render a git-style diff with `@pierre/diffs`, highlighted with the same Shiki theme as your code blocks and produced entirely at build time (no client JavaScript). Accepts two inline strings (`old`/`new`), two file paths (`before`/`after`), or a unified patch (an inline `patch` string or a `src` file).

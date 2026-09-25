---
"blume": patch
---

`blume translate` now looks for `meta.ts` titles only in the folders the content source's `include` globs reach, the same meta files the build reads. A `meta.ts` elsewhere under a project-rooted source (beside tooling, say) configures no sidebar group, and it used to be translated anyway.

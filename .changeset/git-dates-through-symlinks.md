---
"blume": patch
---

With `lastModified: "git"`, a project opened through a symlink (such as `/tmp` on macOS, which links to `/private/tmp`) now gets its "Last updated" dates. Blume compared the project's path against the one git reports with the link resolved, so it treated every content folder as outside the repository and dated no page, without a warning.

---
"blume": patch
---

`%` is now dropped from routes the way `:` already was, so `sdks/100%.md` publishes at `/sdks/100` and sidebar and pagination links reach it, where a bare `%` used to break the build's URL decoding; `#` and `?` in a frontmatter `slug` are dropped the same way. A file or folder with `#` or `?` in its name is reported as an error and left out of the site: Astro's content loader can't read such a file, so it used to publish a page that only ever said "Page not found". A frontmatter `slug` with a `.` or `..` segment (`../../etc/escape`, `guides/./x`) is now rejected with an error at the key instead of publishing a page no link could reach. A group folder's numeric prefix now works on either side of the parentheses: `(01-zeta)` sorts first instead of last, and `01-(gamma)` publishes at `/g` as a "Gamma" group instead of at `/(gamma)/g`.

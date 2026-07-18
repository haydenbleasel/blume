---
"blume": patch
---

Add a themeable content-column width. A new `--blume-content-width` token (default `42rem`) is exposed as a `max-w-content` utility through Tailwind's `--container-content` theme key, and the article, breadcrumb, mobile table of contents, page feedback, pagination, and last-updated line now use it instead of hardcoding `42rem`. Override `--blume-content-width` to re-measure the whole column at once; the default is unchanged.

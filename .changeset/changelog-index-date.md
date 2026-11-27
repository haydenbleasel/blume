---
"blume": patch
---

Date the generated `/changelog` index by its newest entry that search engines may index. The page now shows a "Last updated" line and carries a JSON-LD `dateModified`, and the sitemap gives it a `<lastmod>`. A `noindex` release, such as one `githubReleases({ noindex })` catches, still shows on the timeline but doesn't count toward the date.

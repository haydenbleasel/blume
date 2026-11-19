---
"blume": minor
---

Add a `noindex` option to `githubReleases()`. `{ minWords: 60 }` marks a release page `noindex` when its notes have fewer than 60 words of prose, not counting headings, code, and changesets' leading commit hashes. `true` marks every release. A noindexed release keeps its page, its place on the `/changelog` timeline, and its RSS item, but leaves the sitemap, `llms.txt`, and structured data.

---
"blume": patch
---

Link the RSS feeds from `llms.txt`. The generated index mirrored the docs navigation but never referenced the per-content-type feeds (e.g. `/blog/rss.xml`), so an agent reading `llms.txt` had no pointer to fresh blog posts or changelog entries. The index now closes with an `## RSS Feeds` section listing each configured feed that has pages, under the same condition the feeds themselves exist — RSS enabled and an absolute `deployment.site` — and carrying any `deployment.base` subpath. This mirrors the `artifacts.feeds` list already emitted in `agent-readability.json`.

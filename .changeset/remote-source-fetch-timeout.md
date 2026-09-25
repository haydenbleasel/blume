---
"blume": patch
---

`mdxRemote()` and `githubReleases()` give up on a request after 30 seconds, like the CMS sources, and the diagnostic names the URL that didn't respond. A server that accepted the connection and never answered used to hang `blume build` and every `blume dev` rescan indefinitely.

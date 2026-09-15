---
"blume": patch
---

Import video blocks from Notion pages. A video block previously rendered as an `unsupported Notion block` comment, so neither uploaded videos nor pasted YouTube links appeared in the output. A YouTube link now becomes a `<YouTube>` embed, and any other video becomes a `<video>` player whose source is downloaded at build time — Notion's uploaded-file URLs are signed and expire, so they would otherwise rot the build.

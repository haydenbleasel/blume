---
"blume": patch
---

`llms.txt` now tells agents when to use the site and where its machine-readable surface lives. A new `ai.llmsTxt.details` option inserts free-form Markdown after the title and summary — the llms.txt spec's details block — for "when to use" guidance, the install command, or the package name in the site's own words. The generated file also closes with two sections that need no configuration: **Agent skills** lists each skill published through `ai.skills` with its description, and **Agent resources** links every artifact the build emits — `llms-full.txt`, the per-page `.md` mirror, the MCP server and its discovery document, the skills index, the API catalog, `agent-readability.json`, and the sitemap — each only when it exists.

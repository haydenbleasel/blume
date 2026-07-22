---
"blume": patch
---

Downlevel `<Component>` to its example's source in agent-facing Markdown. The `/<route>.md` mirror, `llms-full.txt`, and the MCP `get_page` tool now render `<Component path="…" />` as a fenced code block of the example's source (the same code the on-page "Code" tab shows) instead of leaving the raw JSX tag, so agents reading a page get the component's code rather than an opaque element. An unknown path (or a missing `path`) is left verbatim, and a same-name `ai.markdownComponents` serializer still overrides the built-in.

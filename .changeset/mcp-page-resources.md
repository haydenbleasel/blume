---
"blume": patch
---

The hosted MCP server now exposes every page as an MCP resource alongside its tools. `resources/list` enumerates the pages at their served URLs (a `blume:` URI when no `deployment.site` is configured) with a `text/markdown` type, title, and description; `resources/read` returns the page's agent Markdown — the same output `get_page` serves — and accepts a listed URI, a bare route, or a `.md` mirror URL. An unknown URI answers with the protocol's resource-not-found code. The server card advertises the `resources` capability, so clients and readiness scanners that attach context by URI can browse the docs without calling a tool.

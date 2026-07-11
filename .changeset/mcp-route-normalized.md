---
"blume": patch
---

Normalize `mcp.route` to a leading slash (and no trailing slash) like other configured routes: a slash-less value such as `"docs-mcp"` was string-concatenated onto the site origin, so `/.well-known/mcp.json`, the MCP server card, and `agent-readability.json` advertised a malformed URL like `https://acme.comdocs-mcp`.

---
"blume": patch
---

WebMCP now registers two more in-page tools: `read_skill`, which lists the site's published agent skills or returns one's `SKILL.md`, and `navigate_page`, which opens a page of the site in the reader's tab through the client router. The WebMCP `get_page` tool no longer fetches another site's Markdown when handed a route a browser resolves to another origin, like `//host` or `/\host`.

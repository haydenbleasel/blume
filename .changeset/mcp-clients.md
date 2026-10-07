---
"blume": patch
---

Add `agents.mcp.clients` to choose the clients the "Connect to MCP" page action lists after "Copy server URL". `false` lists none, leaving just "Copy server URL", and an array of built-in keys (`"claude-code"`, `"codex"`, `"cursor"`, `"vscode"`) shows just those, in order. The array also takes clients Blume doesn't ship, as `{ label, command }`: the row copies `command` with `{name}` and `{url}` filled in, so a site can offer, say, `copilot mcp add --transport http {name} {url}`. A custom label can be a per-locale map, and `icon` sets its icon (`terminal` by default); an icon name outside Blume's set warns as `BLUME_UNKNOWN_ICON`.

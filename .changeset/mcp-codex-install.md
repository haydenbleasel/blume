---
"blume": patch
---

Add a "Copy Codex command" option to the Connect to MCP menu, alongside the existing Claude Code, Cursor, and VS Code installs. It copies `codex mcp add <name> --url <url>` for the hosted MCP server. Also make `PageActions` labels fall back to the English defaults per-key, so a string missing from a translation renders the default instead of coming out blank.

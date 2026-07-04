---
"blume": patch
---

Improve the page-actions dropdowns (Export, Open in chat, Connect to MCP). Only one opens at a time — opening one closes the others. A menu flips above its trigger when opening downward would run past the viewport bottom (and there's room above), so the Connect to MCP menu no longer gets clipped. Menus keep a padding gap from the viewport edge and size to their content instead of the narrow sidebar column, so longer items like "Copy Claude Code command" no longer wrap.

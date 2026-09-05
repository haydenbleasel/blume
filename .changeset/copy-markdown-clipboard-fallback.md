---
"blume": patch
---

Copy buttons no longer fail silently when the Clipboard API is unavailable or denied. Every copy affordance (Copy as Markdown, code blocks, MCP commands, prompts, color swatches, API panels) now falls back to the legacy `copy` command in in-app browsers, WebViews, insecure origins, and after a denied permission prompt. When nothing lands on the clipboard, the Copy as Markdown and MCP actions flash a localized **Copy failed** label (new `actions.copyFailed` UI string, translated in every shipped pack) instead of showing no feedback at all.

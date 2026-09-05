---
"blume": patch
---

Every copy affordance (Copy as Markdown, code blocks, MCP commands, prompts, color swatches, API panels) now falls back to the legacy `copy` command when the Clipboard API is unavailable or denied — in-app browsers, WebViews, insecure origins, and after a denied permission prompt — instead of doing nothing. When nothing lands on the clipboard even then, the Copy as Markdown and MCP actions flash a localized **Copy failed** label (new `actions.copyFailed` UI string, translated in every shipped pack) rather than showing no feedback at all; the other copy buttons still show no confirmation.

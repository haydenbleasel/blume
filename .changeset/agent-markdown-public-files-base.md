---
"blume": patch
---

With `deployment.base` set, root-relative images and file links in the agent-facing Markdown (`/<route>.md`, `llms-full.txt`, and MCP `get_page`) now gain the base the way the rendered page's do: `![logo](/logo.png)` becomes `/sub/logo.png` and `[spec](/spec.pdf)` becomes `/sub/spec.pdf`. They used to keep the bare root path, which 404s on a subpath deploy.

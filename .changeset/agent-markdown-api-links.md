---
"blume": patch
---

Operation links in the agent-facing Markdown of an API reference overview (`/<route>.md`, `llms-full.txt`, and MCP `get_page`) now include `deployment.base`. With a base of `/sub`, they used to point at `/api/pets/list-pets`, which 404s. In `llms.txt`, page and feed titles with square brackets (`[Beta] Webhooks`) are escaped, so their lines stay links.

---
"blume": patch
---

Publish an agent skill for every site. The build writes a `SKILL.md` named after the site's title, served at `/skill.md` and listed in the skills discovery index, `llms.txt`, and the AI catalog. It's built from what Blume already knows, with no model call: how to read any page as Markdown, `llms.txt`, the MCP server, the API references, the changelog, and a map of the docs with each page's description. It needs `deployment.site` for its absolute links. A skill of the same name in `agents.skills` replaces it, and `agents.skillMd: false` turns it off.

---
"blume": patch
---

The assistant now reads a page's relative links to other pages (`[Install](./install)`, `[Setup](../setup.md)`) as the routes they mean, as the `.md` mirrors, `llms-full.txt`, and MCP `get_page` already did, so the relative links it cites in an answer land on the page they mean. Pages from a remote or CMS source, such as `mdxRemote()`, now get that rewrite on every agent surface too. Before, the assistant read such links as written and could cite `../setup.md`, a link that led nowhere from the answer, and a remote page's links stayed as written on the agent surfaces, though the rendered page and `blume validate` resolved them.

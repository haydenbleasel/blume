---
"blume": patch
---

The assistant now reads a page's links to other pages (`[Install](./install)`, `[Setup](../setup.md)`, `[Setup](/guides/setup.md)`) as the routes they mean, as the `.md` mirrors, `llms-full.txt`, and MCP `get_page` already did, so the links it cites in an answer land on the page they mean. A link on a translated page to a page that isn't translated yet points at the page the assistant can read. Pages from a remote or CMS source, such as `mdxRemote()`, now get that rewrite on every agent surface too. Before, the assistant read such links as written and could cite `../setup.md`, a link that led nowhere from the answer, and a remote page's links stayed as written on the agent surfaces, though the rendered page and `blume validate` resolved them. A relative link in a raw HTML `<a href>` now points on the agent surfaces where it goes on the rendered page, resolved against the page's URL as the browser resolves it, rather than the way a Markdown link resolves.

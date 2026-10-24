---
"blume": patch
---

A link the agent surfaces and the assistant rewrite to a route with a space, a parenthesis, or a quote in it (`my page.md` publishes at `/my page`) now has those characters percent-encoded, so it's still a link, also inside a component's quoted `href`. Before, `[Mine](./my%20page.md)` became `[Mine](/my page)`, which shows as text. The page links in `llms.txt`, the site's agent skill, the changelog list, and an API reference operation list now encode a parenthesis or a quote the same way, so one in a route can't end the link early.

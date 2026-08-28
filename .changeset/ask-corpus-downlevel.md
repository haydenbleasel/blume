---
"blume": patch
---

Downlevel components in the Ask AI grounding corpus, the way the `.md` mirror, `llms-full.txt` and MCP `get_page` already do. Ask AI was built from the search documents' verbatim Markdown, so a page whose body is a `<CardGroup>` of `<Card>`s reached the model as JSX with no prose in it — and section landing pages, which are exactly that shape, rank first for section-level questions. `prop={frontmatter.*}` expressions now resolve here too.

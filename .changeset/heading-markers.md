---
"blume": minor
---

Custom heading anchors and table-of-contents markers, matching Fumadocs' syntax so migrated content works verbatim. Append `[#custom-id]` to any heading to pin its anchor id — the marker never renders, links keep working after a heading is reworded, and pinned anchors stay identical across translated locales, where auto-generated ids differ per language. `[!toc]` keeps a heading on the page but out of the table of contents; `[toc]` does the reverse, adding a TOC-only entry that renders as an invisible anchor target so its link still scrolls somewhere — useful for labeling sections built from components rather than prose. Markers chain in any order (`## Heading [toc] [#id]`), work in Markdown and MDX, are stripped from search indexing, and `blume validate` resolves anchor links against pinned ids (including case-sensitive ones).

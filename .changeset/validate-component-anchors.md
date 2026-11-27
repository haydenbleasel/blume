---
"blume": patch
---

`blume validate` now accepts a link to an accordion item, an expandable, or a tab on an `.mdx` page. An accordion item answers to its `id`, or else its title slugged (`#slow-installs` for `<AccordionItem title="Slow installs">`), and an expandable to its title slugged; an id that repeats on the page gets `-2`, `-3` after the first. A tab answers to its `id`, and in a group that opens tabs from the URL hash, a tab without one answers to its title slugged. Before, only headings, raw HTML ids, and `<a name>` counted, so a link that opened one of these was reported as `BLUME_BROKEN_ANCHOR`.

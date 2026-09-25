---
"blume": patch
---

Front matter that opens with a blank line after its `---` fence is now read as front matter, the way Astro reads it. Blume used to treat that `---` as a divider, so the page's `draft`, `slug`, and `hidden` were ignored while Astro stripped the block, and its YAML leaked into search and `llms.txt`. A block that holds no key–value pairs now reads as empty front matter, again matching Astro.

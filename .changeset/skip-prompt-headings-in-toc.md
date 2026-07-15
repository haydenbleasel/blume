---
"blume": patch
---

Stop headings inside a `<Prompt>` block from leaking into the page's table of contents. `Prompt.astro` renders its children into a permanently `hidden` node (used only to build the copy-to-clipboard and Cursor-deeplink text), but `extractHeadings` had no way to know that — any `##` inside a `<Prompt>` was extracted as a real page heading and appeared in the "On this page" sidebar, linking to content that never renders visibly. Heading extraction now tracks `<Prompt>`/`</Prompt>` nesting depth the same way fenced code blocks already are, and skips headings while inside one.

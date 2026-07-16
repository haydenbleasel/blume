---
"blume": patch
---

Stop headings inside a `<Prompt>` block from leaking into the page's table of contents. `Prompt.astro` renders its children into a permanently `hidden` node (used only to build the copy-to-clipboard and Cursor-deeplink text), but `extractHeadings` had no way to know that — any `##` inside a `<Prompt>` was extracted as a real page heading and appeared in the "On this page" sidebar, linking to content that never renders visibly. Heading extraction now tracks `<Prompt>`/`</Prompt>` nesting depth the same way fenced code blocks already are, and skips headings while inside one. Tag detection is anchored to line starts — block-level JSX in MDX starts its own line — so a prose or heading mention of `<Prompt>` never opens a hidden region, and a tag whose attributes span several lines only counts once its closing `>` shows it isn't self-closing.

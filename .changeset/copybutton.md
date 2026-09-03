---
"blume": patch
---

Make room for the copy button in code blocks that have no language bar to hold it. Inside a component whose chrome is `not-prose` — `<Tabs>`, `<CodeGroup>`, `<Steps>`, `<Callout>`, `<Card>`, `<Accordion>` and the rest — the bar is cleared but the button is not, and the block's `padding-top` was the 1rem chosen for a block with no chrome at all, so the button painted over the first line of code. The same applied to an untitled `<CodeBlock>` in plain prose, which renders no bar. Both now reserve the button's strip, as does a raw `<pre><code>` block written in prose, which gets a button but has no language bar either; the clearance is keyed on the docs layout that injects the button, so a custom page layout without it keeps the plain inset.

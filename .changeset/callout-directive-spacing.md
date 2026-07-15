---
"blume": patch
---

Fix the spacing inside directive callouts (`:::note`, `:::success`, …). The global prose paragraph rule leaks a 1rem margin onto the callout's paragraphs even though the callout is `not-prose`, and with a title the body paragraph isn't the first child — so that margin stacked under the title's own gap and left a too-large space between the title and the body. The Callout now overrides that margin locally for a uniform, compact gap between the title, paragraphs, and lists. Callouts without a title and normal prose spacing are unchanged.

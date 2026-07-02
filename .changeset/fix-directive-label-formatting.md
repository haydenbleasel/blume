---
"blume": patch
---

Keep formatted words in a callout's `[label]` title. The title text was gathered only from a paragraph's immediate text children, so any bold, italic, inline-code, or linked word was dropped — `:::note[Read **this** now]` became `Read  now`. The label text is now collected recursively, preserving every word.

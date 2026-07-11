---
"blume": patch
---

Recognize setext headings (`Title` underlined with `=` or `-`) and ATX headings indented 1-3 spaces when extracting headings, matching what the renderer actually renders — these previously vanished from the TOC, search, and page metadata and triggered false `BLUME_BROKEN_ANCHOR` warnings. Underline look-alikes (front matter delimiters, thematic breaks, list/blockquote closers, table delimiter rows, fenced-code content) are not misread as setext underlines.

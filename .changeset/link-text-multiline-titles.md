---
"blume": patch
---

A page title with a line break in it, as a folded YAML `title: >` ends with or a literal `title: |` holds, is now read as one line, so it no longer breaks a link built from it: the assistant's citation heading, the `llms.txt` and agent skill page lists, and the changelog release list. Before, the line break split the link across two lines, so it showed as text. In `llms-full.txt`, such a title also split its page's section heading, and a page that opened with the same heading showed it twice.

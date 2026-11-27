---
"blume": patch
---

Clicking an "On this page" link now always highlights that link. The browser can land the heading a fraction of a pixel below the scroll padding (at 72.05px instead of 72px), and the scrollspy used to read that as not yet reached, so the previous link stayed highlighted. A heading less than a pixel below the line now counts as reached.

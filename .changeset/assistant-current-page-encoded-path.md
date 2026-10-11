---
"blume": patch
---

The assistant now finds the page the reader is on when its route has letters beyond ASCII or a space in it (`/sv/översikt`), so it grounds its answer in that page first and keeps to its docs version. Before, it looked the page up by the percent-encoded path the browser sends, found nothing, and answered as if the reader were on no page.

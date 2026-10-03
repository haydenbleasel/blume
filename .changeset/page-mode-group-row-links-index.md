---
"blume": patch
---

In `page` display mode, a sidebar group with an `index` page now links its row to that page, as `group` and `flat` mode already did: clicking the row opens the section's landing page with its panel open, even when the index page sets `sidebar.hidden: true`. Before, the row only slid the panel in and left the previous page on screen. The row of the section holding the current page is now highlighted too, so after the back arrow the parent panel still shows where you are, and clicking that row slides straight back into the panel. A group without an index page keeps a plain drill-in row.

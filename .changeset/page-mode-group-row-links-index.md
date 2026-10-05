---
"blume": patch
---

In `page` display mode, a sidebar group with an `index` page now links its row's name to that page, as `group` and `flat` mode already did: clicking the name opens the section's landing page with its panel open, even when the index page sets `sidebar.hidden: true`. Before, the row only slid the panel in and left the previous page on screen. The chevron beside the name still slides the panel in without leaving the page, and a group without an index page keeps its whole row as the drill-in button. The row of the section holding the current page is now highlighted too, so after the back arrow the parent panel still shows where you are, and clicking the name of the section's own page slides its panel back in without reloading.

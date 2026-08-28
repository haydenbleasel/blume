---
"blume": patch
---

Cap the search dialog's section-filter row so the results keep the dialog. The dialog is a fixed height and the filter chips wrapped without a bound, so on a site with many sections the chips took the height and the results list got the remainder — measured on an 18-section corpus, the row wanted 266px of the 480 and left about one visible result. The row now shows two rows of chips plus the top of a third as the scroll cue, chips no longer wrap on long section names, the selected chip is scrolled into view when the chips reorder as the query narrows, and each chip exposes its selected state as `aria-pressed`.
